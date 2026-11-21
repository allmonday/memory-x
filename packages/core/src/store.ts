import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
  uid TEXT,
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
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS episodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, id);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
CREATE TABLE IF NOT EXISTS evidence(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_path TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_leaf ON evidence(node_path, leaf_hash);
CREATE TABLE IF NOT EXISTS changes(
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  path TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  before TEXT,
  PRIMARY KEY(revision_id, uid)
) WITHOUT ROWID;
`;

interface NodeRow {
  id: number;
  uid: string;
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
  uid: string;
  title: string;
  leaves: string[];
  content: string | null;
  summary: string | null;
  summaryHash: string | null;
  parentPath: string | null;
  parentUid: string | null;
  ord: number;
  depth: number;
}

/** 节点在某一版本的状态（undo log 的 before 值）。parent 用 uid 引用，跨移动稳定。 */
export interface NodeState {
  title: string;
  leaves: string[];
  content: string | null;
  summary: string | null;
  summaryHash: string | null;
  parentUid: string | null;
  ord: number;
}

/** 一次写入的逐节点 undo 行（uid 为键，同一版本内每节点最多一行）。 */
export interface DeltaEntry {
  uid: string;
  path: string;
  deleted: boolean;
  /** 变更前状态；null = 本节点为新增（undo = 删除） */
  before: NodeState | null;
}

/** 扁平 uid 索引中的一个节点（uid → 路径 + 状态）。 */
export interface UidNode {
  path: string;
  state: NodeState;
}

/** 给树中缺 uid 的节点补发稳定 uid（幂等）。 */
export function ensureUids(root: MemoryNode): void {
  const walk = (n: MemoryNode) => {
    if (!n.uid) n.uid = randomUUID();
    for (const c of n.children) walk(c);
  };
  walk(root);
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** FlatNode → undo 用的节点状态。 */
function stateOf(f: FlatNode): NodeState {
  return {
    title: f.title,
    leaves: f.leaves,
    content: f.content,
    summary: f.summary,
    summaryHash: f.summaryHash,
    parentUid: f.parentUid,
    ord: f.ord,
  };
}

/** 节点状态是否相同（决定是否要落 undo 行）。 */
function stateEq(a: NodeState, b: NodeState): boolean {
  return (
    a.title === b.title &&
    (a.content ?? null) === (b.content ?? null) &&
    (a.summary ?? null) === (b.summary ?? null) &&
    (a.summaryHash ?? null) === (b.summaryHash ?? null) &&
    a.parentUid === b.parentUid &&
    a.ord === b.ord &&
    arrEq(a.leaves, b.leaves)
  );
}

/**
 * 转义 LIKE 模式中的通配符（`\`、`%`、`_`），配合 `... LIKE ? ESCAPE '\'` 使用。
 * 物化 path 可能含这些字符（如标题带 `%`），不转义会误伤/越界匹配。
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** 叶子事实的内容指纹（sha1 前 16 位），用于 evidence 弱链接（不改叶子类型）。 */
export function leafHash(leaf: string): string {
  return createHash("sha1").update(leaf.trim()).digest("hex").slice(0, 16);
}

/** 原始事件（会话/工具记录，逐字保存）。 */
/** 按日聚合结果：日记派生的素材。 */
export interface DayDigest {
  date: string;
  sessions: Array<{
    sessionId: string | null;
    events: number;
    tools: number;
    replies: number;
    firstUser: string | null;
    userSamples: string[];
  }>;
  /** 动过的节点（聚合到前 3 层路径）及写入次数 */
  nodes: Array<{ path: string; ops: number }>;
  /** 素材水位：日记缓存据此判失效（当天又有新事件/新写入则需重建） */
  watermark: { maxEpisodeId: number; maxRevisionId: number };
  empty: boolean;
}

export interface Episode {
  id: number;
  sessionId: string | null;
  seq: number;
  role: string;
  kind: string;
  text: string;
  toolName: string | null;
  createdAt: string;
}

/** 叶子 ↔ 原始事件的链接。 */
export interface EvidenceRef {
  nodePath: string;
  leafHash: string;
  episodeId: number;
}

/** 变更审计行（从 undo log + 物化态派生，不落盘；供 /memory changes 与 log --diff）。 */
export interface ChangeRow {
  revisionId: number;
  /** 该版本的操作名（如 tidy/upsert）与人类可读说明，便于按版本归组回滚 */
  revOp: string;
  revDetail: string | null;
  op: string;
  path: string;
  uid: string;
  fromText: string | null;
  toText: string | null;
  createdAt: string;
}

/** 节点历史条目：某版本为该节点【写入】的值（只记写入侧；被取代的旧值在其出生版本已列出，不重复）。 */
export interface HistoryRow {
  revisionId: number;
  /** 版本级操作名（upsert/update/tidy…）与说明，便于归组 */
  revOp: string;
  revDetail: string | null;
  createdAt: string;
  /** add=add-node 建节点；add/remove=叶子增删；rename/note/summary/move/delete=节点级 */
  op: string;
  /** 写入的值（叶子文本 / 新标题 / 新摘要 / 新正文）；remove/move/delete 无写入值为 null */
  value: string | null;
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
 * 每个节点带稳定 uid（跨版本寻址，不随路径变化）与物化完整链路 path
 * （重名兄弟自动 [n] 消歧），content 字段承载节点完整信息（RAG 语料）。
 * 版本历史 = revisions 时间线 + changes 逐节点 undo log（存变更前状态）；
 * 任意版本由当前态逆推 undo 行物化，无需整树快照。
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

  private columns(table: string): Set<string> {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
  }

  /**
   * 轻量迁移：旧库补列（summary/uid）+ 把旧 schema 的 revisions/changes 升级为 undo log。
   * CREATE TABLE IF NOT EXISTS 不会改已存在的表，故结构变更都在此处显式处理。
   */
  private migrate(): void {
    let destructive = false;
    const nodeCols = this.columns("nodes");
    if (!nodeCols.has("summary")) this.db.exec("ALTER TABLE nodes ADD COLUMN summary TEXT");
    if (!nodeCols.has("summary_hash")) this.db.exec("ALTER TABLE nodes ADD COLUMN summary_hash TEXT");
    if (!nodeCols.has("uid")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN uid TEXT");
      const rows = this.db.prepare("SELECT id FROM nodes").all() as Array<{ id: number }>;
      const upd = this.db.prepare("UPDATE nodes SET uid = ? WHERE id = ?");
      for (const r of rows) upd.run(randomUUID(), r.id);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_uid ON nodes(uid)");

    // 版本历史：旧 revisions 带整树快照列 tree → 丢弃整段旧历史（快照无法转成 undo log，
    // 留着会误导回滚），时间线从 baseline 重新开始。
    const revCols = this.columns("revisions");
    if (revCols.has("tree")) {
      destructive = true;
      this.db.exec("BEGIN");
      this.db.exec("DROP TABLE revisions");
      this.db.exec(`CREATE TABLE revisions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL, path TEXT, actor TEXT NOT NULL DEFAULT 'pi',
        detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      this.db.exec("COMMIT");
    } else if (!revCols.has("detail")) {
      this.db.exec("ALTER TABLE revisions ADD COLUMN detail TEXT");
    }

    // 变更审计 → undo log：旧字段审计行（id/op/from_text）与新语义不兼容，重建。
    const chCols = this.columns("changes");
    if (chCols.has("from_text") || chCols.has("id")) this.db.exec("DROP TABLE changes");
    this.db.exec(`CREATE TABLE IF NOT EXISTS changes(
      revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      uid TEXT NOT NULL, path TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      before TEXT, PRIMARY KEY(revision_id, uid)
    ) WITHOUT ROWID`);

    // 丢弃整树快照后回收空间（一次性；失败不阻断打开）
    if (destructive) {
      try {
        this.db.exec("VACUUM");
      } catch (e) {
        if (process.env.MX_DEBUG) console.error("VACUUM failed:", e);
      }
    }
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
      .prepare("SELECT id, uid, parent_id, ord, title, path, depth, content, summary, summary_hash FROM nodes ORDER BY depth, ord, id")
      .all() as NodeRow[];
    if (nodeRows.length === 0) return { title: "Memory", leaves: [], children: [] };

    const leafRows = this.db
      .prepare("SELECT node_id, ord, text FROM leaves ORDER BY node_id, ord, id")
      .all() as { node_id: number; ord: number; text: string }[];

    const byId = new Map<number, MemoryNode & { __id: number; __parent: number | null }>();
    for (const r of nodeRows) {
      byId.set(r.id, {
        uid: r.uid,
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
      uid: n.uid,
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
    ensureUids(root);
    const insertNode = this.db.prepare(
      "INSERT INTO nodes(uid, parent_id, ord, title, path, depth, content, summary, summary_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          const info = insertNode.run(child.uid, parentId, ord++, child.title, path, depth, child.content ?? null, child.summary ?? null, child.summaryHash ?? null);
          const id = Number(info.lastInsertRowid);
          for (let i = 0; i < child.leaves.length; i++) {
            insertLeaf.run(id, i, child.leaves[i]!);
          }
          walk(child, id, path, depth + 1);
        }
        return ord;
      };
      const rootInfo = insertNode.run(root.uid, null, 0, root.title, "", 0, root.content ?? null, root.summary ?? null, root.summaryHash ?? null);
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
   * 以物化 path 为定位键：新增/更新按 path upsert，删除按 path 级联。
   * 未被本进程改动的节点不出现在 diff 中，因此不会被覆盖（多写者安全）。
   *
   * 返回 uid 空间的 undo 行（每节点最多一条）：新增 before=null，
   * 删除 deleted=true+before=旧态，修改 before=旧态。重命名/移动视为同 uid
   * 的一条修改行（路径变了但身份不变），undo 时可精确改回原路径。
   */
  applyDelta(base: MemoryNode, next: MemoryNode): DeltaEntry[] {
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
      `INSERT INTO nodes(uid, parent_id, ord, title, path, depth, content, summary, summary_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         uid = excluded.uid, parent_id = excluded.parent_id, ord = excluded.ord,
         title = excluded.title, depth = excluded.depth, content = excluded.content,
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
        upsertRow.run(v.uid, parentId, v.ord, v.title, p, v.depth, v.content, v.summary, v.summaryHash);
        const nodeId = (idOf.get(p) as { id: number }).id;
        delLeaves.run(nodeId);
        for (let i = 0; i < v.leaves.length; i++) insLeaf.run(nodeId, i, v.leaves[i]!);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    // uid 空间 undo 行
    const baseByUid = new Map<string, { path: string; state: NodeState }>();
    for (const [path, v] of b) baseByUid.set(v.uid, { path, state: stateOf(v) });
    const nextByUid = new Map<string, { path: string; state: NodeState }>();
    for (const [path, v] of n) nextByUid.set(v.uid, { path, state: stateOf(v) });
    const delta: DeltaEntry[] = [];
    for (const [uid, nb] of nextByUid) {
      const ob = baseByUid.get(uid);
      if (!ob) delta.push({ uid, path: nb.path, deleted: false, before: null });
      else if (!stateEq(ob.state, nb.state)) delta.push({ uid, path: ob.path, deleted: false, before: ob.state });
    }
    for (const [uid, ob] of baseByUid) {
      if (!nextByUid.has(uid)) delta.push({ uid, path: ob.path, deleted: true, before: ob.state });
    }
    return delta;
  }

  /** 扁平化整树：物化 path → 节点元数据（与 saveTree 同一套 [n] 消歧规则）。 */
  private flatten(root: MemoryNode): Map<string, FlatNode> {
    const out = new Map<string, FlatNode>();
    const walk = (node: MemoryNode, path: string, parentPath: string | null, parentUid: string | null, ord: number, depth: number) => {
      out.set(path, {
        uid: node.uid!,
        title: node.title,
        leaves: node.leaves,
        content: node.content ?? null,
        summary: node.summary ?? null,
        summaryHash: node.summaryHash ?? null,
        parentPath,
        parentUid,
        ord,
        depth,
      });
      const counts = new Map<string, number>();
      node.children.forEach((c, i) => {
        const seen = (counts.get(c.title) ?? 0) + 1;
        counts.set(c.title, seen);
        const seg = seen > 1 ? `${c.title}[${seen}]` : c.title;
        walk(c, path === "" ? seg : `${path}/${seg}`, path, node.uid!, i, depth + 1);
      });
    };
    walk(root, "", null, null, 0, 0);
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

  // ---------- 版本历史（MVCC，移植自 MindMap X） ----------
  // 真相 = 当前 nodes/leaves。revisions 只存时间线元数据（一行一次 mutation，无树内容）；
  // changes = 逐节点 undo log（键 uid，存变更【前】状态）。
  // 任意版本由「当前态 + 撤销 revision_id > target 的 before 行」物化（降序逆向回溯）。
  // 不变式：回滚是前进（新版本），历史永不改写、永不裁剪。

  /** 记录一次变更的时间线元数据，返回版本号。 */
  recordRevision(op: string, path: string | null, detail: string | null = null, actor = "pi"): number {
    const info = this.db
      .prepare("INSERT INTO revisions(op, path, actor, detail) VALUES (?, ?, ?, ?)")
      .run(op, path, actor, detail);
    return Number(info.lastInsertRowid);
  }

  revisionCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM revisions").get() as { n: number };
    return row.n;
  }

  latestRevisionId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM revisions").get() as { id: number };
    return row.id;
  }

  /**
   * 每节点的改写次数（uid → 次数）。
   * 口径：节点「语义态」（title/leaves/content/summary）在版本链上被改变的次数。
   * 创建（before=null）不计；纯位置变化（ord/parentUid，含兄弟移动引起的重排）不计。
   * 供 memory_read 标注「该节点有历史」，让模型知道值可能被取代过。
   */
  rewriteCounts(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT uid, before FROM changes WHERE before IS NOT NULL ORDER BY uid, revision_id")
      .all() as Array<{ uid: string; before: string }>;
    if (rows.length === 0) return new Map();
    const semanticEq = (a: NodeState, b: NodeState): boolean =>
      a.title === b.title &&
      (a.content ?? null) === (b.content ?? null) &&
      (a.summary ?? null) === (b.summary ?? null) &&
      arrEq(a.leaves, b.leaves);
    const cur = this.currentByUid();
    const out = new Map<string, number>();
    // 同 uid 的 before 序列（升序）：第 i 行的 after 态 = 第 i+1 行的 before 或当前态
    let uid = "";
    let states: NodeState[] = [];
    const flush = (): void => {
      if (states.length === 0) return;
      let after: NodeState | null = cur.get(uid)?.state ?? null;
      let n = 0;
      for (let i = states.length - 1; i >= 0; i--) {
        const b = states[i]!;
        if (after == null || !semanticEq(b, after)) n++;
        after = b;
      }
      if (n > 0) out.set(uid, n);
      states = [];
    };
    for (const r of rows) {
      if (r.uid !== uid) {
        flush();
        uid = r.uid;
      }
      states.push(JSON.parse(r.before) as NodeState);
    }
    flush();
    return out;
  }

  /** 已删除节点的兑底寻址：按 changes 里记录过的物化路径精确匹配最后一次出现的 uid。 */
  uidByRecordedPath(path: string): string | null {
    const row = this.db
      .prepare("SELECT uid FROM changes WHERE path = ? ORDER BY revision_id DESC LIMIT 1")
      .get(path) as { uid: string } | undefined;
    return row?.uid ?? null;
  }

  /**
   * 某节点的历史值（新→旧）：每次写入的值各列一条，不做 from/to 对偶——
   * 同 uid 的 before 链（升序）即「上一版末态」，末行 after 补当前态；
   * 相邻快照 diff 只取写入侧（新增叶子/新标题/新正文），被移除的旧值不重列。
   * deleted 行（before 里的末态）只发 delete 标记；回滚复活按 before=null 重新走建节点分支。
   */
  listNodeHistory(uid: string): HistoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.revision_id AS rev, c.path AS path, c.deleted AS deleted, c.before AS before,
                r.op AS rev_op, r.detail AS rev_detail, r.created_at AS created_at
         FROM changes c JOIN revisions r ON r.id = c.revision_id
         WHERE c.uid = ? ORDER BY c.revision_id ASC`,
      )
      .all(uid) as Array<{
      rev: number;
      path: string;
      deleted: number;
      before: string | null;
      rev_op: string;
      rev_detail: string | null;
      created_at: string;
    }>;
    if (rows.length === 0) return [];
    const current = this.currentByUid().get(uid)?.state ?? null;
    const out: HistoryRow[] = [];
    const emit = (r: (typeof rows)[number], op: string, value: string | null): void => {
      out.push({
        revisionId: r.rev,
        revOp: r.rev_op,
        revDetail: r.rev_detail,
        createdAt: r.created_at,
        op,
        value,
      });
    };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const b: NodeState | null = r.before == null ? null : (JSON.parse(r.before) as NodeState);
      // 本版末态 = 下一行的 before（下一行 before=null 说明节点在本版之后不存在）；末行补当前态
      const nextRow = rows[i + 1];
      const a: NodeState | null = nextRow
        ? nextRow.before == null
          ? null
          : (JSON.parse(nextRow.before) as NodeState)
        : current;
      if (b == null) {
        // 建节点（含回滚复活）：写入侧 = 初始标题 + 全部叶子 + 正文/摘要
        if (a == null) continue; // 防御：不应发生（无中生有的删除行）
        emit(r, "add-node", a.title);
        for (const leaf of a.leaves) emit(r, "add", leaf);
        if (a.content != null) emit(r, "note", a.content);
        if (a.summary != null) emit(r, "summary", a.summary);
        continue;
      }
      if (a == null) {
        emit(r, "delete", null);
        continue;
      }
      if (a.title !== b.title) emit(r, "rename", a.title);
      const oldSet = new Set(b.leaves);
      const newSet = new Set(a.leaves);
      for (const leaf of a.leaves) if (!oldSet.has(leaf)) emit(r, "add", leaf);
      for (const leaf of b.leaves) if (!newSet.has(leaf)) emit(r, "remove", null);
      if ((a.content ?? null) !== (b.content ?? null)) emit(r, "note", a.content);
      if ((a.summary ?? null) !== (b.summary ?? null)) emit(r, "summary", a.summary);
      if (a.parentUid !== b.parentUid || a.ord !== b.ord) emit(r, "move", null);
    }
    return out.reverse(); // 新→旧
  }

  listRevisions(
    limit = 20,
  ): Array<{ id: number; op: string; path: string | null; actor: string; detail: string | null; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT id, op, path, actor, detail, created_at FROM revisions ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{
      id: number;
      op: string;
      path: string | null;
      actor: string;
      detail: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      op: r.op,
      path: r.path,
      actor: r.actor,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /** 写入一次变更的逐节点 undo 行（uid 唯一键，重复 uid 合并）。 */
  recordChanges(revisionId: number, entries: DeltaEntry[]): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO changes(revision_id, uid, path, deleted, before) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const e of entries) {
        stmt.run(revisionId, e.uid, e.path, e.deleted ? 1 : 0, e.before == null ? null : JSON.stringify(e.before));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 记录一次变更：时间线行 + 逐节点 undo 行（同一事务外调用，顺序保证一致）。 */
  commitRevision(
    op: string,
    path: string | null,
    detail: string | null,
    entries: DeltaEntry[],
    actor = "pi",
  ): number {
    const rev = this.recordRevision(op, path, detail, actor);
    this.recordChanges(rev, entries);
    return rev;
  }

  /** 当前节点的 uid 索引（uid → 路径 + 状态）。 */
  private currentByUid(): Map<string, UidNode> {
    const nodeRows = this.db
      .prepare("SELECT id, uid, parent_id, ord, title, path, content, summary, summary_hash FROM nodes")
      .all() as Array<{
      id: number;
      uid: string;
      parent_id: number | null;
      ord: number;
      title: string;
      path: string;
      content: string | null;
      summary: string | null;
      summary_hash: string | null;
    }>;
    const leafRows = this.db
      .prepare("SELECT node_id, ord, text FROM leaves ORDER BY node_id, ord, id")
      .all() as Array<{ node_id: number; ord: number; text: string }>;
    const leavesByNode = new Map<number, string[]>();
    for (const l of leafRows) {
      const arr = leavesByNode.get(l.node_id) ?? [];
      arr.push(l.text);
      leavesByNode.set(l.node_id, arr);
    }
    const uidById = new Map<number, string>();
    for (const r of nodeRows) uidById.set(r.id, r.uid);
    const map = new Map<string, UidNode>();
    for (const r of nodeRows) {
      map.set(r.uid, {
        path: r.path,
        state: {
          title: r.title,
          leaves: leavesByNode.get(r.id) ?? [],
          content: r.content,
          summary: r.summary,
          summaryHash: r.summary_hash,
          parentUid: r.parent_id == null ? null : (uidById.get(r.parent_id) ?? null),
          ord: r.ord,
        },
      });
    }
    return map;
  }

  /** undo 行（uid 空间）。 */
  private undoRows(afterRevision: number): Array<{ uid: string; path: string; deleted: boolean; before: string | null }> {
    return this.db
      .prepare("SELECT uid, path, deleted, before FROM changes WHERE revision_id > ? ORDER BY revision_id DESC, uid")
      .all(afterRevision) as Array<{ uid: string; path: string; deleted: boolean; before: string | null }>;
  }

  /** 从 uid 索引重建内存树（子节点按 ord 排序）。 */
  private treeFromUid(map: Map<string, UidNode>): MemoryNode {
    const childrenOf = new Map<string, Array<{ uid: string; u: UidNode }>>();
    let root: { uid: string; u: UidNode } | null = null;
    for (const [uid, u] of map) {
      if (u.state.parentUid == null) {
        root = { uid, u };
      } else {
        const arr = childrenOf.get(u.state.parentUid) ?? [];
        arr.push({ uid, u });
        childrenOf.set(u.state.parentUid, arr);
      }
    }
    if (!root) throw new Error("版本物化失败：找不到根节点");
    const build = (uid: string, u: UidNode): MemoryNode => {
      const kids = (childrenOf.get(uid) ?? []).sort((a, b) => a.u.state.ord - b.u.state.ord);
      return {
        uid,
        title: u.state.title,
        leaves: [...u.state.leaves],
        content: u.state.content,
        summary: u.state.summary,
        summaryHash: u.state.summaryHash,
        children: kids.map((k) => build(k.uid, k.u)),
      };
    };
    return build(root.uid, root.u);
  }

  /**
   * 物化某版本的整树（不存在返回 null）。
   * 当前态出发，撤销 revision_id > target 的 undo 行（降序）即可回到该版本。
   */
  materializeTree(id: number): MemoryNode | null {
    const exists = this.db.prepare("SELECT 1 AS x FROM revisions WHERE id = ?").get(id);
    if (!exists) return null;
    const map = this.currentByUid();
    for (const r of this.undoRows(id)) {
      if (r.before == null) map.delete(r.uid);
      else map.set(r.uid, { path: r.path, state: JSON.parse(r.before) as NodeState });
    }
    return this.treeFromUid(map);
  }

  /** 某版本相对上一版本的节点级变更（git log 风格，从 undo 行 + 物化态派生）。 */
  private deriveChanges(revisionId: number, cap: number): ChangeRow[] {
    const rev = this.db
      .prepare("SELECT id, op, detail, created_at FROM revisions WHERE id = ?")
      .get(revisionId) as { id: number; op: string; detail: string | null; created_at: string } | undefined;
    if (!rev) return [];
    const rows = this.db
      .prepare("SELECT uid, path, deleted, before FROM changes WHERE revision_id = ? ORDER BY path, uid")
      .all(revisionId) as Array<{ uid: string; path: string; deleted: boolean; before: string | null }>;
    if (rows.length === 0) return [];
    // 该版本的末态：从当前态撤销 revision_id > revisionId 的行（本版本行未撤 → 正是本版本末态）
    const after = this.currentByUid();
    for (const r of this.undoRows(revisionId)) {
      if (r.before == null) after.delete(r.uid);
      else after.set(r.uid, { path: r.path, state: JSON.parse(r.before) as NodeState });
    }
    const out: ChangeRow[] = [];
    const push = (op: string, path: string, uid: string, from: string | null, to: string | null) => {
      if (out.length < cap) {
        out.push({
          revisionId,
          revOp: rev.op,
          revDetail: rev.detail,
          op,
          path,
          uid,
          fromText: from,
          toText: to,
          createdAt: rev.created_at,
        });
      }
    };
    for (const r of rows) {
      if (r.before == null) {
        const a = after.get(r.uid);
        if (!a) continue;
        push("add-node", a.path, r.uid, null, a.state.title);
        for (const leaf of a.state.leaves) push("add", a.path, r.uid, null, leaf);
        continue;
      }
      const b = JSON.parse(r.before) as NodeState;
      if (r.deleted) {
        push("remove-node", r.path, r.uid, b.title, null);
        for (const leaf of b.leaves) push("remove", r.path, r.uid, leaf, null);
        continue;
      }
      const a = after.get(r.uid);
      if (!a) continue;
      if (a.state.title !== b.title) push("rename", r.path, r.uid, b.title, a.state.title);
      const oldSet = new Set(b.leaves);
      const newSet = new Set(a.state.leaves);
      for (const leaf of a.state.leaves) if (!oldSet.has(leaf)) push("add", a.path, r.uid, null, leaf);
      for (const leaf of b.leaves) if (!newSet.has(leaf)) push("remove", a.path, r.uid, leaf, null);
      if ((a.state.content ?? null) !== (b.content ?? null)) push("note-content", a.path, r.uid, null, null);
      if ((a.state.summary ?? null) !== (b.summary ?? null)) push("note-summary", a.path, r.uid, null, null);
      if (a.state.parentUid !== b.parentUid || a.state.ord !== b.ord) push("move", a.path, r.uid, null, null);
    }
    return out;
  }

  listChanges(opts: { revisionId?: number; limit?: number } = {}): ChangeRow[] {
    const limit = opts.limit ?? 50;
    if (opts.revisionId != null) return this.deriveChanges(opts.revisionId, limit);
    const revs = this.db
      .prepare("SELECT id FROM revisions ORDER BY id DESC LIMIT ?")
      .all(Math.max(limit * 2, 50)) as Array<{ id: number }>;
    const out: ChangeRow[] = [];
    for (const r of revs) {
      out.push(...this.deriveChanges(r.id, limit - out.length));
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  // ---------- 原始证据（episodes / evidence） ----------

  appendEpisodes(
    rows: Array<{ sessionId?: string | null; seq?: number; role: string; kind: string; text: string; toolName?: string | null }>,
  ): number[] {
    if (rows.length === 0) return [];
    const stmt = this.db.prepare(
      "INSERT INTO episodes(session_id, seq, role, kind, text, tool_name) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const ids: number[] = [];
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const info = stmt.run(r.sessionId ?? null, r.seq ?? 0, r.role, r.kind, r.text, r.toolName ?? null);
        ids.push(Number(info.lastInsertRowid));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return ids;
  }

  listEpisodes(opts: { sessionId?: string; limit?: number; sinceId?: number } = {}): Episode[] {
    const limit = opts.limit ?? 50;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.sessionId) {
      clauses.push("session_id = ?");
      params.push(opts.sessionId);
    }
    if (opts.sinceId != null) {
      clauses.push("id > ?");
      params.push(opts.sinceId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, session_id, seq, role, kind, text, tool_name, created_at FROM episodes ${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: number;
      session_id: string | null;
      seq: number;
      role: string;
      kind: string;
      text: string;
      tool_name: string | null;
      created_at: string;
    }>;
    return rows.reverse().map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      role: r.role,
      kind: r.kind,
      text: r.text,
      toolName: r.tool_name,
      createdAt: r.created_at,
    }));
  }

  countEpisodes(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
    return row.n;
  }

  /** 保留最新 keep 条，返回删除条数（关联 evidence 随外键级联删除）。 */
  pruneEpisodes(keep: number): number {
    const before = this.countEpisodes();
    const k = Math.max(0, Math.floor(keep));
    if (before <= k) return 0;
    this.db.exec(
      `DELETE FROM episodes WHERE id NOT IN (SELECT id FROM episodes ORDER BY id DESC LIMIT ${k})`,
    );
    return before - this.countEpisodes();
  }

  /** 按本地日历日聚合：sessions（episodes 分组）+ 动过的节点（changes 聚合到前 3 层路径）+ 素材水位。 */
  dayDigest(date: string): DayDigest {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD：${date}`);
    // 当地日历日的 UTC 边界（created_at 存 UTC）。用可索引的区间比较代替
    // date(col,'localtime')=…（函数谓词吃不上 idx_episodes_created_at，episodes
    // 只增不减，量上去后全表扫逐行求值 date() 会劣化到几百 ms）。
    // 边界 = 当地零点 + 24h；无 DST 时区（如东八区）与 SQLite localtime 语义完全等价。
    const start = new Date(`${date}T00:00:00`); // 无时区后缀 = 本地时间
    const end = new Date(start.getTime() + 86_400_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const utcStr = (d: Date): string =>
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const day = (col: string) => `${col} >= '${utcStr(start)}' AND ${col} < '${utcStr(end)}'`; // date 已过正则校验
    const sessions = (
      this.db
        .prepare(
          `SELECT session_id AS sid, COUNT(*) AS events,
                  SUM(CASE WHEN kind='tool_result' THEN 1 ELSE 0 END) AS tools,
                  SUM(CASE WHEN kind='assistant' THEN 1 ELSE 0 END) AS replies,
                  MIN(CASE WHEN kind='user' THEN text END) AS firstUser
           FROM episodes WHERE ${day("created_at")} GROUP BY session_id ORDER BY MIN(id)`,
        )
        .all() as Array<{ sid: string | null; events: number; tools: number; replies: number; firstUser: string | null }>
    ).map((r) => ({
      sessionId: r.sid,
      events: r.events,
      tools: r.tools,
      replies: r.replies,
      firstUser: r.firstUser?.slice(0, 80) ?? null,
      userSamples: (
        this.db
          .prepare(
            `SELECT text FROM episodes WHERE ${day("created_at")} AND kind='user' AND session_id IS ? ORDER BY id LIMIT 3`,
          )
          .all(r.sid) as Array<{ text: string }>
      ).map((x) => x.text.slice(0, 100)),
    }));
    const touchedRows = this.db
      .prepare(
        `SELECT c.path AS path FROM changes c
         JOIN revisions r ON r.id = c.revision_id
         WHERE ${day("r.created_at")}`,
      )
      .all() as Array<{ path: string }>;
    // 精确路径分组，再只保留最深路径（中间祖先节点的创建行折叠进后代，一次逻辑写入不出多条）
    const exact = new Map<string, number>();
    for (const t of touchedRows) exact.set(t.path, (exact.get(t.path) ?? 0) + 1);
    const paths = [...exact.keys()];
    const nodes = paths
      .filter((p) => !paths.some((q) => q.startsWith(p + "/")))
      .map((p) => ({ path: p, ops: exact.get(p)! }))
      .sort((a, b) => b.ops - a.ops);
    const maxId = (table: string) =>
      (this.db.prepare(`SELECT MAX(id) AS m FROM ${table} WHERE ${day(table === "episodes" ? "created_at" : "created_at")}`).get() as { m: number | null }).m ?? 0;
    return {
      date,
      sessions,
      nodes,
      watermark: { maxEpisodeId: maxId("episodes"), maxRevisionId: maxId("revisions") },
      empty: sessions.length === 0 && touchedRows.length === 0,
    };
  }

  linkEvidence(nodePath: string, leafHashValue: string, episodeIds: number[]): void {
    if (episodeIds.length === 0) return;
    const stmt = this.db.prepare("INSERT INTO evidence(node_path, leaf_hash, episode_id) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const id of episodeIds) stmt.run(nodePath, leafHashValue, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  evidenceFor(nodePath: string, leafHashValue?: string): EvidenceRef[] {
    const rows = (
      leafHashValue
        ? this.db
            .prepare(
              "SELECT node_path, leaf_hash, episode_id FROM evidence WHERE node_path = ? AND leaf_hash = ? ORDER BY episode_id",
            )
            .all(nodePath, leafHashValue)
        : this.db
            .prepare("SELECT node_path, leaf_hash, episode_id FROM evidence WHERE node_path = ? ORDER BY episode_id")
            .all(nodePath)
    ) as Array<{ node_path: string; leaf_hash: string; episode_id: number }>;
    return rows.map((r) => ({ nodePath: r.node_path, leafHash: r.leaf_hash, episodeId: r.episode_id }));
  }

  /** 按 id 批量取 episode（保持入参顺序去重后的升序）。 */
  getEpisodes(ids: number[]): Episode[] {
    const uniq = [...new Set(ids)].filter((n) => Number.isInteger(n));
    if (uniq.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, session_id, seq, role, kind, text, tool_name, created_at FROM episodes WHERE id IN (${uniq.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...uniq) as Array<{
      id: number;
      session_id: string | null;
      seq: number;
      role: string;
      kind: string;
      text: string;
      tool_name: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      role: r.role,
      kind: r.kind,
      text: r.text,
      toolName: r.tool_name,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
