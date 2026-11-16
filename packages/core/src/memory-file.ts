import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic.ts";
import { snapshot } from "./git.ts";
import { deleteNode, moveNode, upsertNode } from "./ops.ts";
import { parseMarkdown } from "./parser.ts";
import { resolvePath } from "./path.ts";
import { serializeMarkdown } from "./serializer.ts";
import type { MemoryNode, OpResult, Resolved } from "./types.ts";

export const MEMORY_FILE = "MEMORY.md";
const EMPTY_DOC = "# Memory\n";

/**
 * 记忆文件对象：一棵 Markdown 大纲树的内存映像 + 原子持久化 + git 快照。
 * 单进程内使用（并发锁由 M0 后期的 proper-lockfile 补齐）。
 */
export class MemoryFile {
  readonly dir: string;
  root: MemoryNode;

  private constructor(dir: string, root: MemoryNode) {
    this.dir = dir;
    this.root = root;
  }

  static async open(dir: string): Promise<MemoryFile> {
    let md: string;
    try {
      md = await readFile(join(dir, MEMORY_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") md = EMPTY_DOC;
      else throw e;
    }
    return new MemoryFile(dir, parseMarkdown(md));
  }

  get filePath(): string {
    return join(this.dir, MEMORY_FILE);
  }

  readSection(path: string): Resolved | null {
    return resolvePath(this.root, path, { fuzzy: true });
  }

  async upsertNode(path: string, leaf: string): Promise<OpResult> {
    const r = upsertNode(this.root, path, leaf);
    if (!r.changed) return { ok: true, path: r.resolvedPath, revision: null, changed: false };
    return this.persist("upsert", r.resolvedPath);
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
    await mkdir(this.dir, { recursive: true });
    await atomicWriteFile(this.filePath, serializeMarkdown(this.root));
    const revision = await snapshot(this.dir, `memory: ${op} ${path}`);
    return { ok: true, path, revision, changed: true };
  }
}
