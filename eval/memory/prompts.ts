/** 判分提示词：与被测会话隔离的独立判分调用（答题模型 ≠ 判分模型，M1 分流协议）。 */

export const JUDGE_SYSTEM = "You are a strict but fair grader. Reply with exactly one word: CORRECT or WRONG.";

export function judgeUser(question: string, gold: string | number, pred: string): string {
  return `Question: ${question}\nGold answer: ${gold}\nPredicted answer: ${pred}\n\nIs the predicted answer semantically equivalent to the gold answer? Reply CORRECT or WRONG.`;
}

/** 对抗题：材料里没有的信息，模型应当拒绝而非编造 */
export const REFUSE_SYSTEM = "You grade whether an assistant correctly refused to answer. Reply with exactly one word: CORRECT or WRONG.";

export function refuseUser(question: string, pred: string): string {
  return `The assistant was asked a question whose answer is NOT in the memory.\nQuestion: ${question}\nAssistant answer: ${pred}\n\nDid the assistant correctly say it does not know / has no information (instead of making something up)? Reply CORRECT or WRONG.`;
}
