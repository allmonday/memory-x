import type { MemoryNode, Resolved } from "./types.ts";

export interface ResolveOptions {
  /** 末段精确匹配失败时，按编辑距离模糊匹配兄弟节点（默认 false） */
  fuzzy?: boolean;
}

/**
 * 路径寻址：`工作/pi生态调研/待办`。
 * 兄弟重名消歧：`项目[2]`（1-based，省略 = 第 1 个）。
 */
export function parsePath(path: string): string[] {
  const segs = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segs.length === 0) throw new Error("路径为空");
  return segs;
}

export function splitDisambig(seg: string): { title: string; nth: number } {
  const m = /^(.*)\[(\d+)\]$/.exec(seg);
  if (m && m[1]!.length > 0) return { title: m[1]!, nth: parseInt(m[2]!, 10) };
  return { title: seg, nth: 1 };
}

/** 沿路径解析节点；失败返回 null（不抛错，由调用方决定语义）。 */
export function resolvePath(root: MemoryNode, path: string, opts: ResolveOptions = {}): Resolved | null {
  let current = root;
  let parent: MemoryNode | null = null;
  let index = -1;
  for (const seg of parsePath(path)) {
    const { title, nth } = splitDisambig(seg);
    let node = nthSibling(current.children, title, nth);
    if (!node && opts.fuzzy) node = fuzzySibling(current.children, title, nth);
    if (!node) return null;
    parent = current;
    index = current.children.indexOf(node);
    current = node;
  }
  return { node: current, parent, index };
}

function nthSibling(siblings: MemoryNode[], title: string, nth: number): MemoryNode | undefined {
  if (nth < 1) return undefined;
  let seen = 0;
  for (const c of siblings) {
    if (c.title === title) {
      seen++;
      if (seen === nth) return c;
    }
  }
  return undefined;
}

/** 末段模糊匹配：编辑距离 ≤ max(1, len/4)，按距离升序取第 nth 个。 */
function fuzzySibling(siblings: MemoryNode[], title: string, nth: number): MemoryNode | undefined {
  const threshold = Math.max(1, Math.floor(title.length / 4));
  const scored = siblings
    .map((c, i) => ({ c, i, d: levenshtein(c.title, title) }))
    .filter((s) => s.d > 0 && s.d <= threshold)
    .sort((a, b) => a.d - b.d || a.i - b.i);
  return scored[nth - 1]?.c;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}
