/**
 * LoCoMo → pi-live 评测的数据装载
 * ==============================
 * LoCoMo（ACL 2024，snap-research/locomo，CC BY-NC 4.0）：10 个双人长对话
 * （各 19~32 场 session，跨度 6~22 个月）。一个对话 = 一次沙盒仿真。
 *
 * 结构（locomo10.json，顶层 Array[10]）：
 * - conversation = { speaker_a, speaker_b, session_N_date_time, session_N:[{speaker, dia_id, text}] }
 *   日期格式 "1:56 pm on 8 May, 2023"；session_N 可能为空数组（跳过）。
 * - qa = { question, answer, evidence:[dia_id], category: 1-5 }
 *   官方类别（task_eval/evaluation.py 确认）：1=Multi-hop 2=Single-hop 3=Temporal
 *   4=Open-domain 5=Adversarial（无 answer，有 adversarial_answer 诱答）。
 *
 * 写入侧无金标（locomo10.json 无 fact/is_update 标注）→ expectRemember /
 * expectReplace 传空数组，主指标=问答五桶；evidence 保留进 probes 供失败归因。
 *
 * 数据集不落仓库（许可限制），从缓存/上游读取。
 */
import { readFile } from "node:fs/promises";
import type { Probe, RecordCase } from "../pi-live/types.ts";

export interface LoComoDialog {
  speaker: string;
  dia_id: string;
  text: string;
}

export interface LoComoQA {
  question: string;
  answer?: string;
  adversarial_answer?: string;
  evidence?: string[];
  category: number;
}

export interface LoComoConversation {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: LoComoQA[];
}

/** 官方类别标签（分桶统计口径，与 LoCoMo task_eval 一致） */
export const LOCOMO_CATEGORY: Record<number, string> = {
  1: "Multi-hop",
  2: "Single-hop",
  3: "Temporal",
  4: "Open-domain",
  5: "Adversarial",
};

const MONTHS = "january february march april may june july august september october november december".split(" ");

/** "1:56 pm on 8 May, 2023" → "2023-05-08"（只取日期；时间对记忆锚定无用） */
export function parseLoCoMoDate(s: string): string | null {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])m\s+on\s+(\d{1,2})\s+([A-Za-z]+)\s*,?\s+(\d{4})\s*$/i.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[5]!.toLowerCase());
  if (mon < 0) return null;
  return `${m[6]}-${String(mon + 1).padStart(2, "0")}-${String(Number(m[4])).padStart(2, "0")}`;
}

/** 开场框架声明（replay 保真度的一部分，与日期前缀同地位——固定文案，非调参数） */
export function openingStatement(a: string, b: string): string {
  return (
    `I'll share with you transcripts of conversations between two people I know well: ${a} and ${b}, ` +
    `recorded over several months. Each line is prefixed with the speaker's name and the date. ` +
    `Please remember the facts, preferences, events, and people mentioned in these conversations, ` +
    `for both ${a} and ${b}. I'll ask you questions about them afterwards.`
  );
}

export async function loadLoCoMo(path: string): Promise<LoComoConversation[]> {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(data) || !data.every((c) => c && typeof c.sample_id === "string" && Array.isArray(c.qa)))
    throw new Error(`LoCoMo 数据格式异常（期望 Array<{sample_id, conversation, qa}>）：${path}`);
  return data as LoComoConversation[];
}

/** LoCoMo 案例 = RecordCase + 对话元信息（说话人双方、有效 session 数） */
export interface LoComoCase extends RecordCase {
  speakers: [string, string];
  sessionCount: number;
}

export function loadConversation(conv: LoComoConversation, opts: { qps?: number } = {}): LoComoCase {
  const c = conv.conversation;
  const speakers: [string, string] = [String(c.speaker_a), String(c.speaker_b)];
  const sessionNums = Object.keys(c)
    .map((k) => /^session_(\d+)$/.exec(k)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

  // 逐 turn：双 speaker 都喂（multi-hop/open-domain 题考双方信息），带说话人前缀
  const turns: Array<{ content: string; date: string | null }> = [];
  let sessionCount = 0;
  for (const n of sessionNums) {
    const dateStr = String(c[`session_${n}_date_time`] ?? "");
    const date = parseLoCoMoDate(dateStr);
    if (date === null) throw new Error(`日期无法解析：${conv.sample_id} session_${n} "${dateStr}"`);
    const dialog = (c[`session_${n}`] ?? []) as LoComoDialog[];
    if (dialog.length === 0) continue; // 空 session（官方 stats 代码同口径跳过）
    sessionCount++;
    for (const t of dialog) {
      if (!t?.text?.trim()) continue;
      turns.push({ content: `${t.speaker}: ${t.text}`, date });
    }
  }

  // 探针：cat5 adversarial → 拒答题（REFUSE 判分），其余语义判分
  const probes: Probe[] = conv.qa.slice(0, opts.qps || undefined).map((q) => {
    const cat = Number(q.category);
    const refuse = cat === 5;
    return {
      question: q.question,
      answer: refuse ? null : (q.answer ?? null),
      refuse,
      tag: LOCOMO_CATEGORY[cat] ?? `cat-${cat}`,
      evidence: q.evidence,
      adversarialAnswer: q.adversarial_answer,
    };
  });

  return { turns, expectRemember: [], expectReplace: [], probes, speakers, sessionCount };
}
