import { forEachWithPath, parsePath, splitDisambig } from "./path.ts";
import { serializeSubtree } from "./serializer.ts";
import type { MemoryNode } from "./types.ts";

export interface Fragment {
  /** 目标节点自身的叶子 */
  leaves: string[];
  /** 目标节点的子树 */
  children: MemoryNode[];
}

const MAX_FRAGMENT_NODES = 300;

/**
 * 解析 outline 片段：与 MEMORY.md 同一文法（标题 + 列表 + 空行），
 * 但首个标题可为任意层级（作为相对基准），首个标题前的列表项归目标节点自身。
 */
export function parseFragment(md: string): Fragment {
  const virtual: MemoryNode = { title: "", leaves: [], children: [] };
  const stack: MemoryNode[] = [virtual];
  let base: number | null = null;

  for (let i = 0; i < md.split("\n").length; i++) {
    const line = md.split("\n")[i]!.trimEnd();
    if (line === "") continue;
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const title = h[2]!.trim();
      if (title === "" || /[/[]/.test(title)) {
        throw new Error(`outline 第 ${i + 1} 行：标题为空或含禁用字符`);
      }
      let depth: number;
      if (base === null) {
        base = level;
        depth = 1;
      } else {
        depth = level - base + 1;
        if (depth < 1) {
          throw new Error(`outline 第 ${i + 1} 行：标题层级高于基准（基准 H${base}）`);
        }
        if (depth > stack.length) {
          throw new Error(`outline 第 ${i + 1} 行：标题层级跳跃`);
        }
      }
      stack.length = depth;
      const node: MemoryNode = { title, leaves: [], children: [] };
      stack[depth - 1]!.children.push(node);
      stack.push(node);
      continue;
    }
    const b = /^- (.+)$/.exec(line);
    if (b) {
      const leaf = b[1]!.trim();
      if (leaf === "") throw new Error(`outline 第 ${i + 1} 行：列表项为空`);
      stack[stack.length - 1]!.leaves.push(leaf);
      continue;
    }
    throw new Error(`outline 第 ${i + 1} 行：无法识别的行 "${line.slice(0, 30)}"`);
  }
  return { leaves: virtual.leaves, children: virtual.children };
}

function countNodes(nodes: MemoryNode[]): number {
  return nodes.reduce((s, n) => s + 1 + countNodes(n.children), 0);
}

/**
 * 用 outline 整体替换目标节点的内容（叶子 + 子树）。
 * 目标节点不存在时按 upsert 语义沿路径创建。
 */
export function applyOutline(
  root: MemoryNode,
  path: string,
  outline: string,
): { changed: boolean; resolvedPath: string } {
  const frag = parseFragment(outline);
  const total = frag.leaves.length + countNodes(frag.children);
  if (total > MAX_FRAGMENT_NODES) {
    throw new Error(`outline 过大（${total} > ${MAX_FRAGMENT_NODES} 个条目），请分批或缩小范围`);
  }

  // 定位或创建目标节点（与 upsertNode 相同的走径语义）
  let current = root;
  const walked: string[] = [];
  for (const seg of parsePath(path)) {
    const { title, nth } = splitDisambig(seg);
    let next: MemoryNode | undefined;
    if (nth > 1) {
      let seen = 0;
      for (const c of current.children) {
        if (c.title === title && ++seen === nth) {
          next = c;
          break;
        }
      }
    } else {
      next = current.children.find((c) => c.title === title);
    }
    if (!next) {
      next = { title, leaves: [], children: [] };
      current.children.push(next);
    }
    walked.push(next.title);
    current = next;
  }

  const before = serializeSubtree(current);
  // content（fenced RAG 语料）不经 outline 表达：按物化路径把旧子树 content 迁回同路径节点。
  // 改名/合并/移动导致路径变化的节点无法映射（会丢失）——与 applyTree 行为一致。
  const savedContent = new Map<string, string>();
  forEachWithPath(current.children, "", (node, p) => {
    if (node.content != null) savedContent.set(p, node.content);
  });
  current.leaves = frag.leaves;
  current.children = frag.children;
  forEachWithPath(current.children, "", (node, p) => {
    const keep = savedContent.get(p);
    if (keep != null) node.content = keep;
  });
  const after = serializeSubtree(current);
  return { changed: before !== after, resolvedPath: walked.join("/") };
}
