/**
 * 评测词面指标（无 LLM）
 * =====================
 * - recall：黄金点内容词 ≥60% 出现在树上（粗判，措辞差异会漏，只作参考）。
 * - precision（叶级修正口径）：更新对中「存在**真过期叶子**」才算残留——
 *   即某条叶子盖住旧值、而对应新值盖不住它。旧值 token 出现在新值也覆盖的
 *   叶子里不算残留（现行表述提及旧背景是合理的）。
 *   已弃用旧的全树词面口径：它在近义改写型数据上会全量误报
 *   （pi-live 冒烟实测：全树口径 0.000 vs 叶级口径 0.917，真失败仅 2/24）。
 */
import type { ReplacePair } from "../pi-live/types.ts";

const STOP = new Set(
  "the a an is are was were be been being of to in on at for with and or but not no do does did this that these those i you he she it we they me him her them my your his its our their as by from what when where who whom which how why".split(/\s+/),
);

/** 内容 token：拉丁词（≥2）+ 中文 2-gram（单字串保留自身） */
export function contentTokens(s: string): string[] {
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const out: string[] = [];
  for (const tok of norm.split(" ")) {
    if (!tok) continue;
    if (/[\u4e00-\u9fff]/.test(tok)) {
      if (tok.length === 1) out.push(tok);
      else for (let i = 0; i + 2 <= tok.length; i++) out.push(tok.slice(i, i + 2));
    } else if (tok.length > 1 && !STOP.has(tok)) {
      out.push(tok);
    }
  }
  return out;
}

/** 文本 a 是否被 b 覆盖：a 的内容 token ≥ ratio 出现在 b 中 */
export function coveredBy(a: string, bTokens: Set<string>, ratio = 0.6): boolean {
  const w = [...new Set(contentTokens(a))];
  if (w.length === 0) return false;
  return w.filter((x) => bTokens.has(x)).length / w.length >= ratio;
}

/** 全树叶子清单 */
export function collectLeaves(root: { leaves: string[]; children: unknown[] }): string[] {
  const out: string[] = [];
  const walk = (n: { leaves: string[]; children: any[] }) => {
    out.push(...n.leaves);
    for (const c of n.children) walk(c);
  };
  walk(root as any);
  return out;
}

/** 抽取 recall：黄金点被树上叶子覆盖的比例（附漏记清单） */
export function recallScore(leaves: string[], expectRemember: string[]): { recall: number; missed: string[] } {
  const w = new Set(leaves.flatMap((l) => contentTokens(l)));
  const missed = expectRemember.filter((x) => !coveredBy(x, w));
  return {
    recall: expectRemember.length ? 1 - missed.length / expectRemember.length : NaN,
    missed,
  };
}

export interface StaleSample {
  old: string;
  neu: string;
  /** 过期叶子原文（盖住旧值且新值盖不住的那条） */
  leaf: string;
}

/**
 * 叶级修正 precision：更新对中不存在真过期叶子的比例。
 * 残留判定：某条叶子 coveredBy(旧值) 且 !coveredBy(新值)——它是旧表述的独占载体。
 */
export function replacePrecision(leaves: string[], pairs: ReplacePair[]): { precision: number; stale: StaleSample[] } {
  const leafToks = leaves.map((l) => new Set(contentTokens(l)));
  const stale: StaleSample[] = [];
  for (const { old, neu } of pairs) {
    for (let i = 0; i < leaves.length; i++) {
      if (coveredBy(old, leafToks[i]!) && !coveredBy(neu, leafToks[i]!)) {
        stale.push({ old, neu, leaf: leaves[i]! });
        break;
      }
    }
  }
  return { precision: pairs.length ? 1 - stale.length / pairs.length : NaN, stale };
}
