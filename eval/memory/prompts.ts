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

// ---------- 更新感知的写入（add / update 操作） ----------

export const UPDATE_SYSTEM = [
  "你维护一棵长期记忆树。给你「当前记忆」（每行 `[路径] 叶子`）和一条「新观察」，输出保持记忆一致的写操作。",
  "规则：",
  "- 若新观察使某条已有叶子过时/被取代/需纠正 → 输出 UPDATE，路径沿用该叶子所在节点。",
  "- 否则输出 ADD，追加到合适路径（可新建）。",
  "- 同一种信息只保留一条：不要既 ADD 新值又留着旧值。",
  "- ADD 的事实用完整句子（含主语/人名/日期，如 `Martin Mark is Male`），不要把信息拆成孤立的键值片段（如只写 `Male`）。",
  "- 用与观察相同的语言；保留人名/日期/数字/关键词；不编造。",
  "输出格式（每行一条，不要其它文字）：",
  "ADD <路径> | <事实>",
  "UPDATE <路径> | <要替换的旧叶子原文> | <新叶子>",
  "UPDATE 的旧叶子原文必须与「当前记忆」里的某行逐字一致且在该节点内唯一。",
].join("\n");

export function updateUser(memoryLines: string, date: string | undefined, text: string): string {
  return `当前记忆：\n${memoryLines || "（空）"}\n\n新观察${date ? `（${date}）` : ""}：\n${text}\n\n请输出写操作。`;
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
