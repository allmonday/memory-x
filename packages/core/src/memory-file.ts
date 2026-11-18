import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tocDigest, type TocOptions } from "./digest.ts";
import { applyOutline, parseFragment } from "./fragment.ts";
import { withDirLock } from "./lock.ts";
import { deleteNode, moveNode, upsertNode } from "./ops.ts";
import { parseMarkdown } from "./parser.ts";
import { canonicalPathOf, resolvePath, forEachWithPath } from "./path.ts";
import { effectiveSummary, summaryHash } from "./summary.ts";
import { serializeSubtree } from "./serializer.ts";
import { MemoryStore } from "./store.ts";
import type { MemoryNode, OpResult, Resolved } from "./types.ts";

export const MEMORY_FILE = "MEMORY.md";
const EMPTY_DOC = "# Memory\n";

/**
 * 记忆文件对象（B 案存储 + 版本历史）：
 *
 *   真相源   .memory/memory.db（nodes 表 + revisions 变更日志）
 *   版本历史  每次 persist 记一条整树快照（MAX_REVISIONS 内保留）；
 *            回滚 = 加载快照落为新版本（历史不改写，可再回滚回来）
 *   崩溃安全  SQLite WAL 事务（无镜像文件、无 git）
 *
 * 工作模型：open 时整树载入内存，操作改内存树，persist 整树单事务写回 +
 * 记版本 + 重建检索索引。旧版 Markdown 数据在 db 为空时自动导入（一次性）。
 */
export class MemoryFile {
  readonly dir: string;
  root: MemoryNode;
  private readonly store: MemoryStore;
  /** 内存树对应的 DB 版本号；用于检测其它进程/session 的写入 */
  private loadedRevision = 0;
  /** 最近一次与 DB 对齐的树基线；persist 时用它算增量 diff */
  private base: MemoryNode = { title: "Memory", leaves: [], children: [] };

  private constructor(dir: string, root: MemoryNode, store: MemoryStore) {
    this.dir = dir;
    this.root = root;
    this.store = store;
  }

  static async open(dir: string): Promise<MemoryFile> {
    await mkdir(dir, { recursive: true });
    const store = MemoryStore.open(dir);
    let root: MemoryNode;
    if (store.isEmpty()) {
      // 迁移：db 为空但存在旧版 MEMORY.md（镜像时代的遗留）→ 导入并记为首个版本
      let md = EMPTY_DOC;
      try {
        md = await readFile(join(dir, MEMORY_FILE), "utf8");
      } catch {
        // 全新目录
      }
      root = parseMarkdown(md);
      if (root.children.length > 0 || root.leaves.length > 0) {
        store.saveTree(root);
        store.rebuildFts();
        store.recordRevision("import", null, root);
      }
    } else {
      root = store.loadTree();
      if (store.ftsIsEmpty()) store.rebuildFts();
      // 版本历史上线前的存量数据 → 记基线版本
      if (store.revisionCount() === 0) {
        store.recordRevision("baseline", null, root);
      }
    }
    const mf = new MemoryFile(dir, root, store);
    mf.loadedRevision = store.listRevisions(1)[0]?.id ?? 0;
    mf.base = structuredClone(root);
    return mf;
  }

  /** 同步从 DB 重载内存树与基线（含版本号）。 */
  private syncFromStore(): void {
    this.root = this.store.loadTree();
    this.base = structuredClone(this.root);
    this.loadedRevision = this.store.listRevisions(1)[0]?.id ?? 0;
  }

  /**
   * 若磁盘上已有更新的版本（别的进程/session 写入），重新载入内存树。
   * 返回是否发生重载。读入口与 UI 服务端在应答前调用，避免读到陈旧缓存。
   */
  reloadIfStale(): boolean {
    const latest = this.store.listRevisions(1)[0]?.id ?? 0;
    if (latest === this.loadedRevision) return false;
    this.root = this.store.loadTree();
    this.base = structuredClone(this.root);
    this.loadedRevision = latest;
    return true;
  }

  get dbPath(): string {
    return join(this.dir, ".memory", "memory.db");
  }

  readSection(path: string): Resolved | null {
    this.reloadIfStale();
    return resolvePath(this.root, path, { fuzzy: true });
  }

  /** 子树的 markdown 片段（无根标题）。 */
  renderSection(path: string): string | null {
    const r = this.readSection(path);
    return r ? serializeSubtree(r.node) : null;
  }

  tocDigest(opts?: TocOptions): string {
    this.reloadIfStale();
    return tocDigest(this.root, opts);
  }

  /**
   * 检索：FTS ∪ LIKE 兜底，命中带完整链路/祖先/兄弟。
   * scope 可选：限定在某个节点及其子树内检索。先模糊解析该路径，
   * 取规范物化路径（含 [n] 消歧）后交给 store；指向根＝全树；解析不到时返回空。
   */
  search(query: string, topK?: number, scope?: string) {
    this.reloadIfStale();
    let canonical: string | undefined;
    if (scope && scope.trim() !== "") {
      const r = resolvePath(this.root, scope, { fuzzy: true });
      if (!r) return [];
      if (r.node === this.root) {
        canonical = undefined; // 根 = 全树
      } else {
        const p = canonicalPathOf(this.root, r.node);
        if (p == null) return [];
        canonical = p;
      }
    }
    const hits = this.store.search(query, topK, canonical);
    if (hits.length > 0) {
      // 附上有效摘要（显式且未陈旧 → 用它；否则推导），供展示
      for (const h of hits) {
        const r = resolvePath(this.root, h.path);
        h.summary = r ? effectiveSummary(r.node) : "";
      }
      this.store.recordAccess(hits.map((h) => h.path));
    }
    return hits;
  }

  /** 记录访问信号（工具 read 命中时调用，P5 排序燃料）。 */
  recordAccess(path: string): void {
    this.store.recordAccess([path]);
  }

  /** 节点完整信息（content）。 */
  readNote(path: string): string | null {
    return this.readSection(path)?.node.content ?? null;
  }

  /** 节点有效摘要（显式且未陈旧 → 用它；否则确定性推导）。 */
  getSummary(path: string): string {
    const r = this.readSection(path);
    return r ? effectiveSummary(r.node) : "";
  }

  /**
   * 写节点摘要（L0，导航用）。text 为空串则清除显式摘要（回退推导摘要）。
   * 写入时记录内容指纹，叶子/子节点变动后 hash 不符即视为陈旧。
   */
  async writeSummary(path: string, text: string): Promise<OpResult> {
    return this.mutate("summary", path, (root) => {
      const r = resolvePath(root, path, { fuzzy: true });
      if (!r) return { ok: false, changed: false, path };
      const next = text.trim() === "" ? null : text.trim();
      const hash = next == null ? null : summaryHash(r.node);
      if (r.node.summary === next && (r.node.summaryHash ?? null) === hash) {
        return { changed: false, path };
      }
      r.node.summary = next;
      r.node.summaryHash = hash;
      return { changed: true, path };
    });
  }

  /** 写节点完整信息（RAG 语料，Markdown）。可含围栏代码块（序列化用动态围栏，不冲突）。 */
  async writeNote(path: string, content: string): Promise<OpResult> {
    return this.mutate("note", path, (root) => {
      const r = resolvePath(root, path, { fuzzy: true });
      if (!r) return { ok: false, changed: false, path };
      if (r.node.content === content) return { changed: false, path };
      r.node.content = content;
      return { changed: true, path };
    });
  }

  async upsertNode(path: string, leaf: string): Promise<OpResult> {
    return this.mutate("upsert", path, (root) => {
      const r = upsertNode(root, path, leaf);
      return { changed: r.changed, path: r.resolvedPath };
    });
  }

  /**
   * 原地替换节点内某条叶子（supersede）：`match` 必须在该节点内**精确且唯一**命中，
   * 否则不做任何改动（ok=false）——防误替换。旧值被替换后即从检索中消失；变更落 revisions 可回滚。
   */
  async updateNode(path: string, match: string, leaf: string): Promise<OpResult> {
    return this.mutate("update", path, (root) => {
      const r = resolvePath(root, path, { fuzzy: true });
      if (!r) return { ok: false, changed: false, path };
      const hits = r.node.leaves.filter((l) => l === match).length;
      if (hits !== 1) return { ok: false, changed: false, path };
      r.node.leaves = r.node.leaves.map((l) => (l === match ? leaf : l));
      return { changed: true, path };
    });
  }

  async applyOutline(path: string, outline: string): Promise<OpResult> {
    return this.mutate("apply_outline", path, (root) => {
      const r = applyOutline(root, path, outline);
      return { changed: r.changed, path: r.resolvedPath };
    });
  }

  async moveNode(from: string, to: string): Promise<OpResult> {
    return this.mutate("move", `${from} -> ${to}`, (root) => {
      const ok = moveNode(root, from, to);
      return { ok, changed: ok, path: from };
    });
  }

  async deleteNode(path: string): Promise<OpResult> {
    return this.mutate("delete", path, (root) => {
      const ok = deleteNode(root, path);
      return { ok, changed: ok, path };
    });
  }

  /** 整树替换（整理/做梦）：outline 为完整新树（相对 H2 起），根不挂叶子。 */
  async applyTree(outline: string): Promise<OpResult> {
    const frag = parseFragment(outline);
    if (frag.leaves.length > 0) {
      throw new Error("整树方案中根节点下不应有列表项（根只承载子域）");
    }
    const count = (ns: import("./types.ts").MemoryNode[]): number =>
      ns.reduce((s, x) => s + 1 + x.leaves.length + count(x.children), 0);
    if (count(frag.children) > 3000) {
      throw new Error("整树方案过大（>3000 条目）");
    }
    return this.mutate("tidy", "(整树)", (root) => {
      // content/summary 不在 outline 中表达：按物化路径把旧树的值迁回同路径节点。
      // 改名/合并/移动导致路径变化的节点，无法自动映射（会丢失）；同路径节点完整保留。
      const savedContent = new Map<string, { content: string | null; summary: string | null; summaryHash: string | null }>();
      forEachWithPath(root.children, "", (node, path) => {
        if (node.content != null || node.summary != null) {
          savedContent.set(path, { content: node.content ?? null, summary: node.summary ?? null, summaryHash: node.summaryHash ?? null });
        }
      });
      forEachWithPath(frag.children, "", (node, path) => {
        const keep = savedContent.get(path);
        if (keep) {
          node.content = keep.content;
          node.summary = keep.summary;
          node.summaryHash = keep.summaryHash;
        }
      });
      root.children = frag.children;
      return { changed: true, path: "(整树)" };
    });
  }

  // ---------- 版本历史 / 回滚 ----------

  listRevisions(limit?: number) {
    return this.store.listRevisions(limit);
  }

  /** 回滚到指定版本：加载快照 → 落为新版本（历史不改写，可再次回滚回来）。 */
  async restoreRevision(id: number): Promise<OpResult> {
    const tree = this.store.getRevisionTree(id);
    if (!tree) return { ok: false, path: `#${id}`, revision: null, changed: false };
    return this.mutate("restore", `#${id}`, (root) => {
      if (JSON.stringify(tree) === JSON.stringify(root)) return { changed: false, path: `#${id}` };
      root.title = tree.title;
      root.leaves = tree.leaves;
      root.content = tree.content;
      root.summary = tree.summary;
      root.summaryHash = tree.summaryHash;
      root.children = tree.children;
      return { changed: true, path: `#${id}` };
    });
  }

  /**
   * 变更包装：在目录锁内先按 DB 版本重载（拿到别的进程的最新写入），再应用改动，
   * 然后只把差异（节点级）写回 DB + 记版本 + 重建索引。
   * —— 消除「改内存旧树 → 整树覆盖」造成的跨会话丢失。
   */
  private async mutate(
    op: string,
    path: string,
    apply: (root: MemoryNode) => { changed: boolean; path: string; ok?: boolean },
  ): Promise<OpResult> {
    return withDirLock(this.dir, async () => {
      this.reloadIfStale(); // 关键：应用前先对齐 DB（含他人写入）
      let res: { changed: boolean; path: string; ok?: boolean };
      try {
        res = apply(this.root);
      } catch (e) {
        this.syncFromStore(); // 失败则丢弃可能的部分改动
        throw e;
      }
      if (!res.changed) {
        return { ok: res.ok ?? true, path: res.path, revision: null, changed: false };
      }
      this.store.applyDelta(this.base, this.root); // 节点级增量写（不再整树 DELETE+INSERT）
      const rev = this.store.recordRevision(op, res.path, this.root); // change log（整树快照）
      this.store.rebuildFts(); // 派生索引
      this.base = structuredClone(this.root);
      this.loadedRevision = rev;
      return { ok: true, path: res.path, revision: String(rev), changed: true };
    });
  }
}
