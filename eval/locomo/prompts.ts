/**
 * LoCoMo 端到端问答/判分提示词。
 * 判分采用业界标准 J-score 方法：二元 LLM 判分（仅类 1-4）。
 */

export const ANSWER_SYSTEM =
  "You answer questions about the two people in their past conversations, using ONLY the retrieved memory excerpts. " +
  "Steps: (1) scan every excerpt; (2) confirm each fact is about the correct person; " +
  "(3) combine facts scattered across excerpts (multi-hop); (4) prefer the most specific detail (names, dates, numbers); " +
  "(5) for time questions, compute from the dates in the excerpts, never guess. " +
  "Be concise. If any excerpt contains relevant information, give the best supported answer; do not refuse.";

export function answerUser(memories: string, question: string): string {
  return `Retrieved memory excerpts:\n${memories}\n\nQuestion: ${question}\n\nAnswer concisely:`;
}

export const JUDGE_SYSTEM = "You are a strict but fair grader. Reply with exactly one word: CORRECT or WRONG.";

export function judgeUser(question: string, gold: string | number, pred: string): string {
  return (
    `Question: ${question}\n` +
    `Gold answer: ${gold}\n` +
    `Predicted answer: ${pred}\n\n` +
    `Is the predicted answer semantically equivalent to the gold answer? Reply CORRECT or WRONG.`
  );
}

/** 解析判分结果（注意 INCORRECT 含子串 CORRECT） */
export function isCorrect(verdict: string): boolean {
  return verdict.trim().toUpperCase().startsWith("CORRECT");
}
