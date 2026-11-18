/** 行级 LCS diff（O(n·m)，记忆树几百行规模绰绰有余） */

export interface DiffLine {
  op: "+" | "-" | " ";
  line: string;
}

export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: "-", line: a[i]! });
      i++;
    } else {
      out.push({ op: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ op: "-", line: a[i++]! });
  while (j < m) out.push({ op: "+", line: b[j++]! });
  return out;
}

/** 变更统计 */
export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.op === "+") added++;
    else if (d.op === "-") removed++;
  }
  return { added, removed };
}

/**
 * 渲染 diff：只保留变更行及其上下文（各 1 行），限制最大输出行数。
 */
export function formatDiff(diff: DiffLine[], maxLines = 120): string {
  const keep = new Set<number>();
  diff.forEach((d, idx) => {
    if (d.op !== " ") {
      for (const k of [idx - 1, idx, idx + 1]) if (k >= 0 && k < diff.length) keep.add(k);
    }
  });
  const parts: string[] = [];
  let last = -2;
  for (const idx of [...keep].sort((x, y) => x - y)) {
    if (idx > last + 1) parts.push("  ⋯");
    const d = diff[idx]!;
    parts.push(`${d.op === " " ? "  " : d.op + " "}${d.line}`);
    last = idx;
  }
  if (parts.length > maxLines) {
    return `${parts.slice(0, maxLines).join("\n")}\n  ⋯（diff 过长已截断，共 ${parts.length} 行）`;
  }
  return parts.join("\n");
}
