/**
 * 自建记忆评估框架 —— 场景驱动、操作级评分
 * ==========================================
 * 参考：
 *   - HaluMem（操作级）：把评测拆到「抽取 / 更新 / 问答」三个阶段
 *   - MemoryAgentBench：能力维度（准确检索、冲突消解、长程理解）
 *
 * 每个场景 = 一段「观察材料」，运行器把它写进 memory-x 沙盒（LLM 抽取或机械），
 * 再对结果评分：
 *   - extraction：期望记住的记住了吗（recall）、期望忽略的没被记吗（precision）
 *   - update / recall / answer：靠 probe 问答（LLM 判分）+ 抽取检查共同判定
 * 沙盒是独立目录，绝不碰真实记忆。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MemoryFile } from "../../packages/core/src/index.ts";
import { LlmClient } from "../llm.ts";
import { ANSWER_SYSTEM, EXTRACT_SYSTEM, JUDGE_SYSTEM, REFUSE_SYSTEM, answerUser, extractUser, judgeUser, refuseUser } from "./prompts.ts";

export interface Observation {
  id?: string;
  date?: string;
  text: string;
}
export interface Probe {
  question: string;
  answer?: string | null;
  /** answer=正常问答；refuse=应该拒绝/说不知道（对抗题） */
  kind?: "answer" | "refuse";
  /** 分类标签（如 HaluMem 的 question_type），用于分桶统计 */
  tag?: string;
}
export interface Scenario {
  id: string;
  title?: string;
  competency: "extraction" | "update" | "recall" | "answer";
  ingest?: "llm" | "mechanical";
  observations: Observation[];
  /** 抽取：期望被记住的要点 */
  expectRemember?: string[];
  /** 抽取：期望不被记的噪音 */
  expectIgnore?: string[];
  /** 召回/问答探针 */
  probes?: Probe[];
}

// ---------- 文本匹配（无需 LLM 的粗判） ----------
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

function allLeaves(mf: MemoryFile): string[] {
  const out: string[] = [];
  const walk = (n: { leaves: string[]; children: any[] }) => {
    out.push(...n.leaves);
    for (const c of n.children) walk(c);
  };
  walk(mf.root as any);
  return out;
}

// ---------- 写入（两种建树方式） ----------
async function ingest(mf: MemoryFile, s: Scenario, llm: LlmClient | null, mode: "llm" | "mechanical"): Promise<void> {
  if (mode === "llm" && llm) {
    for (let i = 0; i < s.observations.length; i++) {
      const o = s.observations[i]!;
      const raw = await llm.chat(EXTRACT_SYSTEM, extractUser(o.date, o.text), 8000);
      // 模型输出可能是 markdown 大纲；宽松提取 `- ` 事实行
      const facts = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[-*+]\s+/.test(l))
        .map((l) => l.replace(/^[-*+]\s+/, "").replace(/[*_`]/g, "").trim())
        .filter(Boolean);
      if (facts.length > 0) {
        const path = `记忆/${o.id ?? `obs-${i + 1}`}`;
        await mf.upsertNode(path, facts[0]!);
        for (const f of facts.slice(1)) await mf.upsertNode(path, f);
      } else if (o.text.trim()) {
        await mf.upsertNode(`原文/${o.id ?? `obs-${i + 1}`}`, o.text.trim());
      }
    }
    return;
  }
  // 机械：原文逐条
  for (let i = 0; i < s.observations.length; i++) {
    const o = s.observations[i]!;
    await mf.upsertNode(`原文/${o.id ?? `obs-${i + 1}`}`, o.text.trim());
  }
}

// ---------- 评分 ----------
export interface Result {
  id: string;
  competency: string;
  /** 抽取：recall（期望记住命中率）/ precision（1-噪音污染率） */
  recall?: number;
  precision?: number;
  /** 问答：正确数 / 总数 */
  qaPass?: number;
  qaTotal?: number;
  /** 问答分类桶：tag → { pass, total } */
  byTag?: Record<string, { pass: number; total: number }>;
  details: string[];
}

export async function runScenario(s: Scenario, opts: { dir: string; llm: LlmClient | null; mode: "llm" | "mechanical" }): Promise<Result> {
  await mkdir(opts.dir, { recursive: true });
  const mf = await MemoryFile.open(opts.dir);
  await ingest(mf, s, opts.llm, opts.mode);

  const leaves = allLeaves(mf);
  const leafWords = new Set(leaves.flatMap((l) => contentTokens(l)));
  const details: string[] = [];
  const res: Result = { id: s.id, competency: s.competency, details };

  const remember = s.expectRemember ?? [];
  if (remember.length > 0) {
    const hit = remember.filter((x) => coveredBy(x, leafWords));
    res.recall = hit.length / remember.length;
    for (const x of remember) if (!hit.includes(x)) details.push(`✗ 漏记：${x}`);
  }
  const ignore = s.expectIgnore ?? [];
  if (ignore.length > 0) {
    const bad = ignore.filter((x) => coveredBy(x, leafWords));
    res.precision = 1 - bad.length / ignore.length;
    for (const x of bad) details.push(`✗ 记了噪音：${x}`);
  }

  const probes = s.probes ?? [];
  if (probes.length > 0 && opts.llm) {
    let pass = 0;
    const byTag: Record<string, { pass: number; total: number }> = {};
    for (const p of probes) {
      const hits = mf.search(p.question, 5);
      const ctx = hits.map((h) => mf.renderSection(h.path) ?? "").join("\n\n---\n\n");
      const pred = (await opts.llm.chat(ANSWER_SYSTEM, answerUser(ctx, p.question))).trim();
      const system = p.kind === "refuse" ? REFUSE_SYSTEM : JUDGE_SYSTEM;
      const user = p.kind === "refuse" ? refuseUser(p.question, pred) : judgeUser(p.question, String(p.answer), pred);
      const verdict = (await opts.llm.chat(system, user, 800)).trim().toUpperCase();
      const ok = verdict.startsWith("CORRECT");
      if (ok) pass++;
      else details.push(`✗ 问答：${p.question} → 「${pred}」（期望「${p.answer ?? "拒绝"}」）`);
      if (p.tag) {
        const b = (byTag[p.tag] ??= { pass: 0, total: 0 });
        b.total++;
        if (ok) b.pass++;
      }
    }
    res.qaPass = pass;
    res.qaTotal = probes.length;
    if (Object.keys(byTag).length > 0) res.byTag = byTag;
  }
  return res;
}
