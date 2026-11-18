import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tocDigest, type TocOptions } from "./digest.ts";
import { applyOutline, parseFragment } from "./fragment.ts";
import { withDirLock } from "./lock.ts";
import { deleteNode, moveNode, upsertNode } from "./ops.ts";
import { parseMarkdown } from "./parser.ts";
import { resolvePath, forEachWithPath } from "./path.ts";
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
    return new MemoryFile(dir, root, store);
  }

  get dbPath(): string {
    return join(this.dir, ".memory", "memory.db");
  }

  readSection(path: string): Resolved | null {
    return resolvePath(this.root, path, { fuzzy: true });
  }

  /** 子树的 markdown 片段（无根标题）。 */
  renderSection(path: string): string | null {
    const r = this.readSection(path);
    return r ? serializeSubtree(r.node) : null;
  }

  tocDigest(opts?: TocOptions): string {
    return tocDigest(this.root, opts);
  }

  /** 检索：FTS ∪ LIKE 兜底，命中带完整链路/祖先/兄弟。 */
  search(query: string, topK?: number) {
    const hits = this.store.search(query, topK);
    if (hits.length > 0) this.store.recordAccess(hits.map((h) => h.path));
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

  /** 写节点完整信息（RAG 语料，Markdown）。可含围栏代码块（序列化用动态围栏，不冲突）。 */
  async writeNote(path: string, content: string): Promise<OpResult> {
    const r = this.readSection(path);
    if (!r) return { ok: false, path, revision: null, changed: false };
    if (r.node.content === content) {
      return { ok: true, path, revision: null, changed: false };
    }
    r.node.content = content;
    return this.persist("note", path);
  }

  async upsertNode(path: string, leaf: string): Promise<OpResult> {
    const r = upsertNode(this.root, path, leaf);
    if (!r.changed) return { ok: true, path: r.resolvedPath, revision: null, changed: false };
    return this.persist("upsert", r.resolvedPath);
  }

  async applyOutline(path: string, outline: string): Promise<OpResult> {
    const r = applyOutline(this.root, path, outline);
    if (!r.changed) return { ok: true, path: r.resolvedPath, revision: null, changed: false };
    return this.persist("apply_outline", r.resolvedPath);
  }

  async moveNode(from: string, to: string): Promise<OpResult> {
    if (!moveNode(this.root, from, to)) {
      return { ok: false, path: from, revision: null, changed: false };
    }
    return this.persist("move", `${from} -> ${to}`);
  }

  async deleteNode(path: string): Promise<OpResult> {
    if (!deleteNode(this.root, path)) {
      return { ok: false, path, revision: null, changed: false };
    }
    return this.persist("delete", path);
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
    // content（fenced RAG 语料）不在 outline 中表达：按物化路径把旧树 content 迁回同路径节点。
    // 改名/合并/移动导致路径变化的节点，content 无法自动映射（会丢失）；同路径节点完整保留。
    const savedContent = new Map<string, string>();
    forEachWithPath(this.root.children, "", (node, path) => {
      if (node.content != null) savedContent.set(path, node.content);
    });
    forEachWithPath(frag.children, "", (node, path) => {
      const keep = savedContent.get(path);
      if (keep != null) node.content = keep;
    });
    this.root.children = frag.children;
    return this.persist("tidy", "(整树)");
  }

  // ---------- 版本历史 / 回滚 ----------

  listRevisions(limit?: number) {
    return this.store.listRevisions(limit);
  }

  /** 回滚到指定版本：加载快照 → 落为新版本（历史不改写，可再次回滚回来）。 */
  async restoreRevision(id: number): Promise<OpResult> {
    const tree = this.store.getRevisionTree(id);
    if (!tree) return { ok: false, path: `#${id}`, revision: null, changed: false };
    if (JSON.stringify(tree) === JSON.stringify(this.root)) {
      return { ok: true, path: `#${id}`, revision: null, changed: false };
    }
    this.root = tree;
    return this.persist("restore", `#${id}`);
  }

  private async persist(op: string, path: string): Promise<OpResult> {
    const revision = await withDirLock(this.dir, async () => {
      this.store.saveTree(this.root); // 真相：整树单事务
      const rev = this.store.recordRevision(op, path, this.root); // change log
      this.store.rebuildFts(); // 派生索引
      return rev;
    });
    return { ok: true, path, revision: String(revision), changed: true };
  }
}
