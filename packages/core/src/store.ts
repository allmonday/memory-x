import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNode } from "./types.ts";

/** 停用词：高频虚词/疑问代词——尤其是双字词会经 LIKE 兜底匹配一切，必须过滤 */
const STOPWORDS = new Set([
  // 中文虚词/疑问词（2-4 字）
  "什么", "怎么", "怎么样", "为什么", "是什么", "什么样", "哪些", "哪个", "哪里",
  "可以", "应该", "可能", "这个", "那个", "这些", "那些", "然后", "但是", "因为",
  "所以", "如果", "还有", "没有", "已经", "现在", "时候", "东西", "地方",
  "我们", "你们", "他们", "一下", "一些", "关于", "请问", "帮我", "告诉",
  "我的", "你的", "他的", "就是", "还是", "以及", "或者", "不是", "一个",
  "之前", "之后", "最近", "上次", "需要", "想看", "看看", "说一下", "有哪些",
  // 英文常用虚词
  "the", "a", "an", "is", "are", "was", "what", "how", "why", "when", "who",
  "can", "could", "should", "would", "do", "does", "did", "my", "your", "his",
  "this", "that", "then", "about", "from", "with", "for", "and", "but", "not",
  "me", "you", "it", "of", "to", "in", "on",
]);

export const STORE_DIR = ".memory";
export const DB_FILE = "memory.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  depth INTEGER NOT NULL,
  content TEXT,
  summary TEXT,
  summary_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, ord);
CREATE TABLE IF NOT EXISTS leaves(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leaves_node ON leaves(node_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  path, title, body, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS access(
  path TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS revisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  path TEXT,
  actor TEXT NOT NULL DEFAULT 'pi',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  tree TEXT NOT NULL
);
`;

/** 历史快照保留上限（超过后裁剪最旧版本；个人规模 ≈ 几 MB） */
export const MAX_REVISIONS = 500;

interface NodeRow {
  id: number;
  parent_id: number | null;
  ord: number;
  title: string;
  path: string;
  depth: number;
  content: string | null;
  summary: string | null;
  summary_hash: string | null;
}

/** 扁平化后的节点元数据（applyDelta 的 diff 单位） */
interface FlatNode {
  title: string;
  leaves: string[];
  content: string | null;
  summary: string | null;
  summaryHash: string | null;
  parentPath: string | null;
  ord: number;
  depth: number;
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 转义 LIKE 模式中的通配符（`\`、`%`、`_`），配合 `... LIKE ? ESCAPE '\'` 使用。
 * 物化 path 可能含这些字符（如标题带 `%`），不转义会误伤/越界匹配。
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export interface SearchHit {
  path: string;
  title: string;
  ancestors: string[];
  siblings: string[];
  snippet: string;
  hasContent: boolean;
  leafCount: number;
  via: "fts" | "like";
  /** 综合分（合入检索分 + 访问/新鲜度加成），越高越前 */
  score: number;
  /** 节点级有效摘要（由 MemoryFile.search 填充；store 直接调用时为空串） */
  summary: string;
}

/**
 * SQLite 存储层（B 案）：nodes 表为操作真相源。
 * 每个节点带物化的完整链路 path（重名兄弟自动 [n] 消歧），
 * content 字段承载节点完整信息（RAG 语料）。
 *
 * 写入策略：整树重写（单事务）。个人记忆规模（≤万级节点）下
 * 全量重建是毫秒级操作，换取与内存树的绝对一致，无增量同步 bug 面。
 * WAL 模式保证崩溃安全。
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  readonly dbPath: string;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 轻量迁移：旧库（无 summary 列）补列。CREATE TABLE IF NOT EXISTS 不会给已存在的表加列。 */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("summary")) this.db.exec("ALTER TABLE nodes ADD COLUMN summary TEXT");
    if (!have.has("summary_hash")) this.db.exec("ALTER TABLE nodes ADD COLUMN summary_hash TEXT");
  }

  static open(dir: string): MemoryStore {
    mkdirSync(join(dir, STORE_DIR), { recursive: true });
    return new MemoryStore(join(dir, STORE_DIR, DB_FILE));
  }

  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number };
    return row.n === 0;
  }

  loadTree(): MemoryNode {
    const nodeRows = this.db
      .prepare("SELECT id, parent_id, ord, title, path, depth, content, summary, summary_hash FROM nodes ORDER BY depth, ord, id")
      .all() as NodeRow[];
    if (nodeRows.length === 0) return { title: "Memory", leaves: [], children: [] };

    const leafRows = this.db
      .prepare("SELECT node_id, ord, text FROM leaves ORDER BY node_id, ord, id")
      .all() as { node_id: number; ord: number; text: string }[];

    const byId = new Map<number, MemoryNode & { __id: number; __parent: number | null }>();
    for (const r of nodeRows) {
      byId.set(r.id, {
        title: r.title,
        leaves: [],
        content: r.content,
        summary: r.summary,
        summaryHash: r.summary_hash,
        children: [],
        __id: r.id,
        __parent: r.parent_id,
      });
    }
    for (const l of leafRows) {
      byId.get(l.node_id)?.leaves.push(l.text);
    }

    let root: (MemoryNode & { __id: number; __parent: number | null }) | undefined;
    for (const r of nodeRows) {
      const node = byId.get(r.id)!;
      if (r.parent_id === null) {
        root = node;
      } else {
        byId.get(r.parent_id)?.children.push(node);
      }
    }
    if (!root) throw new Error("存储损坏：找不到根节点（parent_id 为 NULL 的记录缺失）");
    const clean = (n: MemoryNode & { __id: number; __parent: number | null }): MemoryNode => ({
      title: n.title,
      leaves: n.leaves,
      content: n.content,
      summary: n.summary,
      summaryHash: n.summaryHash,
      children: n.children.map(clean),
    });
    return clean(root);
  }

  /** 整树重写（单事务）。path 物化：重名兄弟追加 [k]（k≥2）。 */
  saveTree(root: MemoryNode): void {
    const insertNode = this.db.prepare(
      "INSERT INTO nodes(parent_id, ord, title, path, depth, content, summary, summary_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertLeaf = this.db.prepare("INSERT INTO leaves(node_id, ord, text) VALUES (?, ?, ?)");

    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM leaves");
      this.db.exec("DELETE FROM nodes");

      const walk = (node: MemoryNode, parentId: number | null, parentPath: string, depth: number): number => {
        let ord = 0;
        const titleCount = new Map<string, number>();
        for (const child of node.children) {
          const seen = (titleCount.get(child.title) ?? 0) + 1;
          titleCount.set(child.title, seen);
          const seg = seen > 1 ? `${child.title}[${seen}]` : child.title;
          const path = parentPath === "" ? seg : `${parentPath}/${seg}`;
          const info = insertNode.run(parentId, ord++, child.title, path, depth, child.content ?? null, child.summary ?? null, child.summaryHash ?? null);
          const id = Number(info.lastInsertRowid);
          for (let i = 0; i < child.leaves.length; i++) {
            insertLeaf.run(id, i, child.leaves[i]!);
          }
          walk(child, id, path, depth + 1);
        }
        return ord;
      };
      const rootInfo = insertNode.run(null, 0, root.title, "", 0, root.content ?? null, root.summary ?? null, root.summaryHash ?? null);
      const rootId = Number(rootInfo.lastInsertRowid);
      for (let i = 0; i < root.leaves.length; i++) {
        insertLeaf.run(rootId, i, root.leaves[i]!);
      }
      walk(root, rootId, "", 1);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- 增量写（节点级，替代整树重写） ----------

  /**
   * 把 base → next 的差异以节点级 SQL 写回（单事务）。
   * 以物化 path 为稳定键：新增/更新按 path upsert，删除按 path 级联。
   * 未被本进程改动的节点不出现在 diff 中，因此不会被覆盖（多写者安全）。
   */
  applyDelta(base: MemoryNode, next: MemoryNode): void {
    const b = this.flatten(base);
    const n = this.flatten(next);

    const removed = [...b.keys()].filter((p) => !n.has(p));
    const upserts: Array<[string, FlatNode]> = [...n.entries()].filter(([p, v]) => {
      const o = b.get(p);
      return (
        !o ||
        o.title !== v.title ||
        o.content !== v.content ||
        o.summary !== v.summary ||
        o.summaryHash !== v.summaryHash ||
        o.parentPath !== v.parentPath ||
        o.ord !== v.ord ||
        !arrEq(o.leaves, v.leaves)
      );
    });
    // 根行总是 upsert：空库首次写入时 base 里的根从未落库
    if (n.has("") && !upserts.some(([p]) => p === "")) upserts.push(["", n.get("")!]);

    const delNode = this.db.prepare("DELETE FROM nodes WHERE path = ?");
    const upsertRow = this.db.prepare(
      `INSERT INTO nodes(parent_id, ord, title, path, depth, content, summary, summary_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         parent_id = excluded.parent_id, ord = excluded.ord, title = excluded.title,
         depth = excluded.depth, content = excluded.content,
         summary = excluded.summary, summary_hash = excluded.summary_hash,
         updated_at = datetime('now')`,
    );
    const idOf = this.db.prepare("SELECT id FROM nodes WHERE path = ?");
    const delLeaves = this.db.prepare("DELETE FROM leaves WHERE node_id = ?");
    const insLeaf = this.db.prepare("INSERT INTO leaves(node_id, ord, text) VALUES (?, ?, ?)");

    this.db.exec("BEGIN");
    try {
      // 删除：深→浅（父级联会带走子树，后续删除自然是幂等 no-op）
      for (const p of removed.sort((x, y) => y.split("/").length - x.split("/").length)) delNode.run(p);
      // 新增/更新：浅→深（保证父先于子落库）
      for (const [p, v] of upserts.sort((x, y) => x[1].depth - y[1].depth)) {
        const parentId =
          v.parentPath === null
            ? null
            : ((idOf.get(v.parentPath) as { id: number } | undefined)?.id ?? null);
        upsertRow.run(parentId, v.ord, v.title, p, v.depth, v.content, v.summary, v.summaryHash);
        const nodeId = (idOf.get(p) as { id: number }).id;
        delLeaves.run(nodeId);
        for (let i = 0; i < v.leaves.length; i++) insLeaf.run(nodeId, i, v.leaves[i]!);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 扁平化整树：物化 path → 节点元数据（与 saveTree 同一套 [n] 消歧规则）。 */
  private flatten(root: MemoryNode): Map<string, FlatNode> {
    const out = new Map<string, FlatNode>();
    const walk = (node: MemoryNode, path: string, parentPath: string | null, ord: number, depth: number) => {
      out.set(path, {
        title: node.title,
        leaves: node.leaves,
        content: node.content ?? null,
        summary: node.summary ?? null,
        summaryHash: node.summaryHash ?? null,
        parentPath,
        ord,
        depth,
      });
      const counts = new Map<string, number>();
      node.children.forEach((c, i) => {
        const seen = (counts.get(c.title) ?? 0) + 1;
        counts.set(c.title, seen);
        const seg = seen > 1 ? `${c.title}[${seen}]` : c.title;
        walk(c, path === "" ? seg : `${path}/${seg}`, path, i, depth + 1);
      });
    };
    walk(root, "", null, 0, 0);
    return out;
  }

  /** 供检索层：按 path 前缀查节点（含完整链路）。通配符已转义。 */
  findByPathPrefix(prefix: string): NodeRow[] {
    return this.db
      .prepare("SELECT * FROM nodes WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY depth, ord")
      .all(prefix, `${escapeLike(prefix)}/%`) as NodeRow[];
  }

  // ---------- 检索层（全部派生，可随时重建） ----------

  /** 整表重建 FTS（毫秒级，persist 后调用）。语料 = path+标题+叶子+content。 */
  rebuildFts(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM memory_fts");
      this.db.exec(`
        INSERT INTO memory_fts(rowid, path, title, body)
        SELECT n.id, n.path, n.title,
          COALESCE((SELECT group_concat(l.text, ' ') FROM leaves l WHERE l.node_id = n.id), '')
          || ' ' || COALESCE(n.content, '')
        FROM nodes n
        WHERE n.path != ''
      `);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  ftsIsEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number };
    return row.n === 0;
  }

  /**
   * 检索：FTS5 trigram（≥3 字词，bm25 排序 + snippet）∪ LIKE 兜底（2 字短词）。
   * 排序 = 检索分 × 访问频次加成 × 新鲜度加成（P5：用得多的记忆更易被召回）。
   * 返回带完整链路/祖先/兄弟/命中片段的富化结果。
   *
   * scope：可选，物化节点路径（由 MemoryFile 模糊解析后规范化）。
   * 只返回该节点自身及其子树的命中（对齐 OpenViking「search a directory, not the whole index」）。
   * 过滤下推到 SQL：FTS 的 LIMIT 在 WHERE 之后，故 scope 下召回仍足量。
   */
  search(query: string, topK = 5, scope?: string): SearchHit[] {
    const sc = scope && scope.trim() !== "" ? scope : undefined;
    const scopePat = sc ? `${escapeLike(sc)}/%` : undefined;
    const tokens = (query.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t.toLowerCase()));
    if (tokens.length === 0) return [];
    // CJK 长词滑窗拆分：整句子串匹配召回过低（"我最喜欢的科学家是谁" 匹配不到含"科学家"的文档）。
    // 拆成重叠 trigram OR 连接，bm25 排序压制噪音。
    const expand = (t: string): string[] => {
      if (t.length >= 4 && /\p{Script=Han}/u.test(t)) {
        const out: string[] = [];
        for (let i = 0; i + 3 <= t.length; i++) out.push(`"${t.slice(i, i + 3)}"`);
        return out;
      }
      return t.length >= 3 ? [`"${t.replace(/"/g, "")}"`] : [];
    };
    const ftsTerms = tokens.flatMap(expand);
    const shortTerms = tokens.filter((t) => t.length === 2).map((t) => t.replace(/[\\%_]/g, " "));
    if (ftsTerms.length === 0 && shortTerms.length === 0) return [];

    interface RawHit {
      path: string;
      title: string;
      snippet: string | null;
      via: "fts" | "like";
      rank: number;
    }
    const seen = new Map<string, RawHit>();

    if (ftsTerms.length > 0) {
      const scopeClause = sc ? " AND (path = ? OR path LIKE ? ESCAPE '\\')" : "";
      const rows = this.db
        .prepare(
          `SELECT path, title,
             snippet(memory_fts, 2, '«', '»', '…', 16) AS snip, rank
           FROM memory_fts WHERE memory_fts MATCH ? AND path != ''${scopeClause}
           ORDER BY rank LIMIT ?`,
        )
        .all(
          ...[ftsTerms.join(" OR ")],
          ...(sc ? [sc, scopePat] : []),
          Math.max(topK * 2, 10),
        ) as Array<{
        path: string;
        title: string;
        snip: string;
        rank: number;
      }>;
      for (const r of rows) {
        seen.set(r.path, { path: r.path, title: r.title, snippet: r.snip, via: "fts", rank: r.rank });
      }
    }

    if (shortTerms.length > 0) {
      const scopeClause = sc ? " AND (n.path = ? OR n.path LIKE ? ESCAPE '\\')" : "";
      for (const term of shortTerms) {
        const pat = `%${term}%`;
        const rows = this.db
          .prepare(
            `SELECT DISTINCT n.path, n.title, n.content FROM nodes n
             LEFT JOIN leaves l ON l.node_id = n.id
             WHERE n.path != '' AND (n.title LIKE ? ESCAPE ' ' OR n.content LIKE ? ESCAPE ' ' OR l.text LIKE ? ESCAPE ' ')${scopeClause}
             LIMIT 50`,
          )
          .all(pat, pat, pat, ...(sc ? [sc, scopePat] : [])) as Array<{ path: string; title: string; content: string | null }>;
        for (const r of rows) {
          if (seen.has(r.path)) continue;
          const body = r.content ?? "";
          const idx = body.indexOf(term);
          const snip =
            idx >= 0
              ? `${idx > 20 ? "…" : ""}${body.slice(Math.max(0, idx - 20), idx + 60)}`
              : r.title;
          seen.set(r.path, { path: r.path, title: r.title, snippet: snip, via: "like", rank: 99 });
        }
      }
    }

    const ordered = [...seen.values()].sort((a, b) => a.rank - b.rank);
    // 信号加成：访问频次（log）+ 新鲜度（30 天线性衰减，仅命中过才算）
    const accessRows = this.db
      .prepare(`SELECT path, hits, last_hit FROM access WHERE ${
        [...seen.keys()].map(() => "path = ?").join(" OR ") || "0"
      }`)
      .all(...seen.keys()) as Array<{ path: string; hits: number; last_hit: number }>;
    const accessByPath = new Map(accessRows.map((r) => [r.path, r]));
    const now = Date.now();
    const scored = ordered.map((h) => {
      const base = h.via === "fts" ? Math.max(0.01, -h.rank) : 0.5; // like 兜底给固定低底分
      const acc = accessByPath.get(h.path);
      let mult = 1;
      if (acc) {
        mult *= 1 + 0.5 * Math.log2(1 + acc.hits); // 2 次命中 +50%，8 次 +200%
        const daysSince = (now - acc.last_hit) / 86_400_000;
        if (daysSince < 30) mult *= 1 + 0.3 * (1 - daysSince / 30); // 近期用过再 +最多30%
      }
      return { ...h, score: Number((base * mult).toFixed(4)) };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((h) => this.enrich(h));
  }

  private enrich(h: {
    path: string;
    title: string;
    snippet: string | null;
    via: "fts" | "like";
    score?: number;
  }): SearchHit {
    const segs = h.path.split("/");
    const parentPath = segs.length > 1 ? segs.slice(0, -1).join("/") : null;
    let siblings: string[] = [];
    let leafCount = 0;
    let hasContent = false;
    if (parentPath !== null) {
      const rows = this.db
        .prepare(
          `SELECT title,
             (SELECT COUNT(*) FROM leaves l WHERE l.node_id = n.id) AS lc,
             (n.content IS NOT NULL) AS hc
           FROM nodes n WHERE n.parent_id = (SELECT id FROM nodes WHERE path = ?)`,
        )
        .all(parentPath) as Array<{ title: string; lc: number; hc: number }>;
      siblings = rows.map((r) => r.title);
      leafCount = rows.find((r) => r.title === h.title)?.lc ?? 0;
      hasContent = Boolean(rows.find((r) => r.title === h.title)?.hc);
    } else {
      const row = this.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM leaves l WHERE l.node_id = n.id) AS lc, (n.content IS NOT NULL) AS hc
           FROM nodes n WHERE n.path = ?`,
        )
        .get(h.path) as { lc: number; hc: number } | undefined;
      leafCount = row?.lc ?? 0;
      hasContent = Boolean(row?.hc);
    }
    return {
      path: h.path,
      title: h.title,
      ancestors: segs.slice(0, -1),
      siblings,
      snippet: h.snippet ?? "",
      hasContent,
      leafCount,
      via: h.via,
      score: h.score ?? 0,
      summary: "",
    };
  }

  /** 记录访问信号（排序燃料，P5）。 */
  recordAccess(paths: string[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO access(path, hits, last_hit) VALUES (?, 1, ?)
       ON CONFLICT(path) DO UPDATE SET hits = hits + 1, last_hit = excluded.last_hit`,
    );
    const now = Date.now();
    for (const p of paths) stmt.run(p, now);
  }

  // ---------- 版本历史（change log，移植自 MindMap X 的 MVCC 语义） ----------
  // 差异：MindMap X 逐节点 before 增量 + 回溯物化；这里整树 JSON 快照，
  // restore = 加载快照，零物化逻辑。共同不变式：回滚是前进（新版本），
  // 历史永不改写。

  /** 记录一次变更（操作后的整树快照），返回版本号。 */
  recordRevision(op: string, path: string | null, tree: unknown, actor = "pi"): number {
    const info = this.db
      .prepare("INSERT INTO revisions(op, path, actor, tree) VALUES (?, ?, ?, ?)")
      .run(op, path, actor, JSON.stringify(tree));
    // 裁剪最旧历史
    this.db.exec(
      `DELETE FROM revisions WHERE id <= (SELECT MAX(id) - ${MAX_REVISIONS} FROM revisions)`,
    );
    return Number(info.lastInsertRowid);
  }

  revisionCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM revisions").get() as { n: number };
    return row.n;
  }

  listRevisions(limit = 20): Array<{ id: number; op: string; path: string | null; actor: string; createdAt: string }> {
    return this.db
      .prepare("SELECT id, op, path, actor, created_at FROM revisions ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ id: number; op: string; path: string | null; actor: string; createdAt: string }>;
  }

  /** 取某版本的整树快照（不存在返回 null）。 */
  getRevisionTree(id: number): MemoryNode | null {
    const row = this.db.prepare("SELECT tree FROM revisions WHERE id = ?").get(id) as
      | { tree: string }
      | undefined;
    return row ? (JSON.parse(row.tree) as MemoryNode) : null;
  }

  close(): void {
    this.db.close();
  }
}
