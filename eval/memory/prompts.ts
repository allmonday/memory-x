/**
 * 判分提示词：与被测会话隔离的独立判分调用（答题模型 ≠ 判分模型，M1 分流协议）。
 *
 * 口径（2026-11-25 LoCoMo conv-1 归因后定型，两处修订）：
 * - judge：**覆盖式等价**——pred 覆盖 gold 全部关键内容即 CORRECT；允许措辞差异、
 *   允许超集（多列真实条目/更具体）。旧「语义等价」对开放列举题把超集判错
 *   （conv-1 实测 ~12 题误伤）。仍为二值判分（无部分分），列举题以全覆盖为线。
 * - refuse（对抗题）：**反编造判据**——「说不知道」与「指出前提错误/纠正归属」都算
 *   CORRECT；判分员持诱答（adversarial_answer）对照，pred 把诱答或编造内容当作
 *   被问者的事实即 WRONG。旧口径只认字面拒答，在说话人对调型陷阱题（LoCoMo cat5
 *   主型）上全量误伤识破陷阱的正确行为（conv-1 实测 23 题全为此类）。
 */

export const JUDGE_SYSTEM = "You are a strict but fair grader. Reply with exactly one word: CORRECT or WRONG.";

export function judgeUser(question: string, gold: string | number, pred: string): string {
  return `Question: ${question}\nGold answer: ${gold}\nPredicted answer: ${pred}\n\nGrade by coverage: the prediction is CORRECT if it covers all key content of the gold answer. It may be worded differently and may include additional true detail or extra items — that is still CORRECT. It is WRONG only if it misses or contradicts a key part of the gold answer. Reply CORRECT or WRONG.`;
}

/** 对抗题：材料里没有该信息（或属于他人），模型应当拒答或纠正前提，而非编造 */
export const REFUSE_SYSTEM =
  "You grade whether an assistant correctly avoided fabricating an answer. Reply with exactly one word: CORRECT or WRONG.";

export function refuseUser(question: string, pred: string, bait?: string): string {
  const baitLine = bait ? `\nTempting wrong answer (what a careless assistant would assert): ${bait}` : "";
  return `The question below is unanswerable from the assistant's memory — the asked-about fact does not exist for that subject, or it belongs to someone else.${baitLine}\nQuestion: ${question}\nAssistant answer: ${pred}\n\nCORRECT if the assistant avoided fabricating: it said it has no such information, or pointed out the false premise (e.g., corrected who the fact actually belongs to), or declined the asked detail while offering related known facts — offering related known facts is not fabrication. WRONG only if it asserted the unanswerable content as the asked subject's fact (matching the tempting answer or inventing specifics). Reply CORRECT or WRONG.`;
}
