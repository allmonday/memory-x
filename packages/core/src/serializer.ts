import type { MemoryNode } from "./types.ts";

/**
 * 序列化为规范 Markdown。
 * 规范形态：标题行 → 叶子列表 → 空行 → 子节点块；文件以单个换行结尾。
 * 保证 serialize(parse(x)) === x（当 x 已是规范形态时）。
 */
export function serializeMarkdown(root: MemoryNode): string {
  const out: string[] = [`# ${root.title}`, ""];
  const walk = (node: MemoryNode, level: number) => {
    out.push(`${"#".repeat(level + 1)} ${node.title}`);
    for (const leaf of node.leaves) out.push(`- ${leaf}`);
    out.push("");
    for (const child of node.children) walk(child, level + 1);
  };
  for (const child of root.children) walk(child, 1);
  return out.join("\n");
}
