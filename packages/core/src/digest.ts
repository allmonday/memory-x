import type { MemoryNode } from "./types.ts";

export interface TocOptions {
  /** 目录展示的最大层级（默认 3） */
  maxDepth?: number;
  /** 输出字符上限（默认 1200，超出截断） */
  maxChars?: number;
}

/**
 * 目录摘要：`- 标题 [子树叶子总数]` 的缩进列表。
 * 用于注入 system prompt（P2：渐进披露，只给地图不给内容）。
 */
export function tocDigest(root: MemoryNode, opts: TocOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 3;
  const maxChars = opts.maxChars ?? 1200;
  const lines: string[] = [];

  const countLeaves = (n: MemoryNode): number =>
    n.leaves.length + n.children.reduce((s, c) => s + countLeaves(c), 0);

  const walk = (n: MemoryNode, depth: number) => {
    if (depth > maxDepth) return;
    const total = countLeaves(n);
    lines.push(`${"  ".repeat(depth - 1)}- ${n.title}${total > 0 ? ` [${total}]` : ""}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const c of root.children) walk(c, 1);

  if (lines.length === 0) return "（记忆树为空）";
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…（已截断，用 memory_read 下钻）`;
  return out;
}
