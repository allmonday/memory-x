/** 自建记忆评估的提示词。 */

export const EXTRACT_SYSTEM = [
  "你负责把一段材料整理成需要长期记住的事实。",
  "只保留有长期价值的：偏好、经历、关系、计划、重要日期、地点、数字、决定等；去掉寒暄与噪音。",
  "用与材料相同的语言；保留人名、日期、数字、关键词；绝不编造材料里没有的内容。",
  "只输出事实行：每行以 '- ' 开头，一条一个事实。不要标题、不要解释、不要代码块。",
].join("\n");

export function extractUser(date: string | undefined, text: string): string {
  return `${date ? `时间：${date}\n` : ""}材料：\n${text}\n\n请输出要长期记住的事实。`;
}

export const ANSWER_SYSTEM =
  "You answer questions using ONLY the retrieved memory excerpts. Combine facts across excerpts. " +
  "Be concise. If the excerpts contain relevant information, answer from them; otherwise say you don't know.";

export function answerUser(context: string, question: string): string {
  return `Retrieved memory:\n${context}\n\nQuestion: ${question}\n\nAnswer concisely:`;
}

export const JUDGE_SYSTEM = "You are a strict but fair grader. Reply with exactly one word: CORRECT or WRONG.";

export function judgeUser(question: string, gold: string | number, pred: string): string {
  return `Question: ${question}\nGold answer: ${gold}\nPredicted answer: ${pred}\n\nIs the predicted answer semantically equivalent to the gold answer? Reply CORRECT or WRONG.`;
}

/** 对抗题：材料里没有的信息，模型应当拒绝而非编造 */
export const REFUSE_SYSTEM = "You grade whether an assistant correctly refused to answer. Reply with exactly one word: CORRECT or WRONG.";

export function refuseUser(question: string, pred: string): string {
  return `The assistant was asked a question whose answer is NOT in the memory.\nQuestion: ${question}\nAssistant answer: ${pred}\n\nDid the assistant correctly say it does not know / has no information (instead of making something up)? Reply CORRECT or WRONG.`;
}
