import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic.ts";
import { tocDigest, type TocOptions } from "./digest.ts";
import { snapshot } from "./git.ts";
import { applyOutline } from "./fragment.ts";
import { withDirLock } from "./lock.ts";
import { deleteNode, moveNode, upsertNode } from "./ops.ts";
import { parseMarkdown } from "./parser.ts";
import { resolvePath } from "./path.ts";
import { serializeMarkdown, serializeSubtree } from "./serializer.ts";
import { MemoryStore } from "./store.ts";
import type { MemoryNode, OpResult, Resolved } from "./types.ts";

export const MEMORY_FILE = "MEMORY.md";
const EMPTY_DOC = "# Memory\n";
const DATA_GITIGNORE = ".memory/\n*.tmp\n.memory.lock\n";

/**
 * 记忆文件对象（B 案存储架构）：
 *
 *   真相源   .memory/memory.db（nodes 表，含物化 path 完整链路与 content 字段）
 *   镜像    MEMORY.md（每次写入后导出，含 fenced content；可完整重建 db，即备份）
 *   历史    git 只跟踪镜像（人类可读 diff；db 不入库）
 *
 * 工作模型：open 时整树载入内存，操作改内存树，persist 整树单事务写回 +
 * 镜像导出 + git 快照。崩溃窗口内镜像可能落后于 db，以 db 为准。
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
    // 数据目录自身的 .gitignore：别把 db 提交进镜像仓库
    const gi = join(dir, ".gitignore");
    try {
      await readFile(gi, "utf8");
    } catch {
      await writeFile(gi, DATA_GITIGNORE, "utf8");
    }

    const store = MemoryStore.open(dir);
    let root: MemoryNode;
    if (store.isEmpty()) {
      // 迁移：db 为空但存在旧版 MEMORY.md（M1 之前的数据）→ 导入
      let md = EMPTY_DOC;
      try {
        md = await readFile(join(dir, MEMORY_FILE), "utf8");
      } catch {
        // 全新目录
      }
      root = parseMarkdown(md);
      if (root.children.length > 0 || root.leaves.length > 0) {
        store.saveTree(root);
      }
    } else {
      root = store.loadTree();
    }
    return new MemoryFile(dir, root, store);
  }

  get filePath(): string {
    return join(this.dir, MEMORY_FILE);
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

  /** 节点完整信息（content）。 */
  readNote(path: string): string | null {
    return this.readSection(path)?.node.content ?? null;
  }

  /** 写节点完整信息（RAG 语料）。 */
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

  private async persist(op: string, path: string): Promise<OpResult> {
    const revision = await withDirLock(this.dir, async () => {
      this.store.saveTree(this.root); // 真相：整树单事务
      await atomicWriteFile(this.filePath, serializeMarkdown(this.root)); // 镜像
      return snapshot(this.dir, `memory: ${op} ${path}`); // 历史（仅镜像）
    });
    return { ok: true, path, revision, changed: true };
  }
}
