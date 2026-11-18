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
  "把你收到的一条「新观察」并入「长期记忆树」。当前记忆每行形如 `[路径] 叶子`。",
  "步骤：",
  "1) 先从新观察里**逐条抽出**值得长期记住的事实（偏好/经历/关系/计划/重要日期/地点/数字/决定），",
  "   每条用**完整句子**（含主语/人名，如 `Martin Mark is Male`），保留关键词/日期/数字，不编造。",
  "2) 对每条抽取事实，判断它是否**明确取代/更正**了当前记忆里的某条叶子：",
  "   - 是（同一对象同一属性取值变了，或明确说「改成/不再/更正/现在」）→ 输出 UPDATE，把那条旧叶子替换为新事实，路径沿用该旧叶子所在节点；",
  "   - 否（补充新信息、或拿不准）→ 输出 ADD。**拿不准一律 ADD，不要 UPDATE。**",
  "3) 不要因为某条要 UPDATE，就漏掉其它事实——抽取完整优先。",
  "输出格式（每行一条，不要其它文字）：",
  "ADD <路径> | <完整句事实>",
  "UPDATE <路径> | <被替换的旧叶子原文> | <完整句新事实>",
  "UPDATE 的旧叶子原文必须与「当前记忆」里某行**逐字一致**且在该节点内唯一。",
].join("\n");

export function updateUser(memoryLines: string, date: string | undefined, text: string): string {
  return `当前记忆：\n${memoryLines || "（空）"}\n\n新观察${date ? `（${date}）` : ""}：\n${text}\n\n请输出写操作。`;
}

// ---------- 第二遍：定向 supersede（仅给已抽出的新事实判 ADD/UPDATE） ----------

export const SUPERSEDE_SYSTEM = [
  "给你「当前记忆」（每行 `[路径] 叶子`）和「本轮新抽出的事实」。为每条新事实决定写入方式：",
  "- 若它**明确取代/更正**当前记忆里的某条旧叶子（同一对象同一属性取值变了，或明确说「改成/不再/更正/现在」）→ 输出 UPDATE，把那条旧叶子替换为该新事实（路径沿用该旧叶子所在节点）；",
  "- 否则（补充新信息、或拿不准）→ 输出 ADD。**拿不准一律 ADD。**",
  "- 不要漏掉任何一条新事实；新事实文本原样用，不要改写。",
  "输出格式（每行一条，不要其它文字）：",
  "ADD <路径> | <新事实原文>",
  "UPDATE <路径> | <被替换的旧叶子原文> | <新事实原文>",
  "UPDATE 的旧叶子原文必须与「当前记忆」里某行**逐字一致**且在该节点内唯一。",
].join("\n");

export function supersedeUser(memoryLines: string, facts: string[]): string {
  return `当前记忆：\n${memoryLines || "（空）"}\n\n本轮新抽出的事实：\n${facts.map((f) => `- ${f}`).join("\n")}\n\n请输出写操作。`;
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
