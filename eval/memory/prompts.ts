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

// ---------- Turn 级 agent 仿真（复刻 extension：目录 + 召回注入，每轮自主 ADD/UPDATE/NOOP） ----------

export const AGENT_WRITE_SYSTEM = [
  "你是记忆管家 agent：每轮对话后，依据「记忆目录」和「召回的记忆全文」决定如何更新长期记忆树。",
  "判断规则：",
  "- 只记跨会话仍有价值的事实：身份/偏好/经历/关系/计划/重要日期/地点/数字/决定；寒暄、情绪性闲聊、一次性信息不记 → NOOP；",
  "- 写入前先看召回：同一对象同一属性若已有叶子，而本轮出现了新取值/新偏好信号（**即使没有明说「替换/不再」**，如与新宠物互动并大加赞赏），必须用 UPDATE 把旧叶子改写为当前状态；**新事实只描述当前状态，不要保留旧取值字样（不要写 previously/used to/不再）**；同属性两条取值并存是错误；",
  "- **并列≠重复**：同一主题下不同属性/不同对象是不同叶子（喜欢猫 ≠ 怕蛇 ≠ 喜欢鹦鹉），各自保留不得合并；NOOP 仅当与现有叶子语义等价；",
  "- 全新主题的新事实 → ADD：路径按主题组织（对象/属性，如 Profile/Pets、Career/Role），不要按时间或 session 命名；缺失的中间节点会自动创建；",
  "- **写入已存在的主题路径前必须先 SEARCH**：若目录中已有该主题节点（如 Profile/Pets）而召回里没有它的叶子 → 先输出一行 `SEARCH <主题词>`（用对象/属性词，如 pets preferences、job role，不要照抄本轮新值的字面词），拿到现有叶子后再决定 UPDATE（同属性新取值）或 NOOP（语义等价）；只有全新主题才可直接 ADD；",
  "- 路径必须照抄目录/节点现状中出现的完整路径（含层级，如 Profile/Pets），不要自创缩写或只写末段；",
  "- 若上下文附有「写入目标节点的当前内容」：同属性新取值必须 UPDATE 对应旧叶子，不得 ADD 并存；语义等价 → NOOP；",
  "- UPDATE 的旧叶子原文与路径都必须与召回/检索结果/节点现状**逐字一致**；确实拿不准是否同属性 → ADD；",
  "- 每条叶子一句完整短句（含人名/主语），保留日期/数字/关键词，用对话的语言；不编造；",
  "输出格式（每行一条，不要其它文字、不要代码块）：",
  "ADD <路径> | <事实>",
  "UPDATE <路径> | <被替换的旧叶子原文> | <新事实>",
  "NOOP",
  "SEARCH <检索词>",
].join("\n");

export function agentWriteUser(
  toc: string,
  recall: string,
  recent: string,
  date: string | undefined,
  turn: string,
  searchResult?: string,
  nodeContext?: string,
): string {
  return [
    `记忆目录：\n${toc || "（空）"}`,
    `\n召回的相关记忆（全文）：\n${recall || "（无）"}`,
    searchResult ? `\n你请求的检索结果：\n${searchResult}` : "",
    nodeContext ? `\n写入目标节点的当前内容（写入前核对，避免并存/重复）：\n${nodeContext}` : "",
    recent ? `\n最近对话（上下文）：\n${recent}` : "",
    `\n本轮对话${date ? `（${date}）` : ""}：\n${turn}`,
    "\n请输出本轮写操作。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 答题提示词：关键是不被"确切日期/版本缺失"卡住——证据在就答，否定性事实也算证据。 */
export const ANSWER_SYSTEM = [
  "Answer the question using ONLY the retrieved memory excerpts.",
  "- If ANY excerpt contains information about the asked subject, answer from it; do NOT reply 'I don't know' merely because the exact date/version is missing.",
  "- For yes/no questions, commit to Yes or No from the evidence. A stored dislike/negative fact counts: if memory says he dislikes X, then 'did he prefer X?' = No.",
  "- If excerpts conflict, prefer the most recent / updated fact and ignore outdated ones.",
  "- Combine facts across excerpts; be concise and specific (names, dates, numbers).",
  "- Only say 'I don't know' if NO excerpt contains anything about the subject.",
].join("\n");

/** HISTORY 协议附加规则（EVAL_HISTORY=1 时启用；无对话日期锚点时版本史会误导 as-of 类问题，默认关闭） */
export const HISTORY_RULE =
  "- If the question asks about CHANGES / HISTORY / EVOLUTION (how X changed, what X used to be, previous values) and the excerpts only show the current state: output exactly one line `HISTORY <path>` (path = the most relevant section path from the excerpts). You will then receive the change timeline to answer from.";

export function answerUser(context: string, question: string, history?: string): string {
  return [
    `Retrieved memory (CURRENT state — authoritative for "what is X now"):\n${context}`,
    history
      ? `\n⚠️ Version history (chronological change log — values tagged [OLD] are SUPERSEDED and NO LONGER current;\n[NEW] was the value at that point; the final/current value is the one in Retrieved memory above.\nTimestamps are write-order, not dialogue dates):\n${history}`
      : "",
    `\nQuestion: ${question}\n\nAnswer concisely:`,
  ]
    .filter(Boolean)
    .join("\n");
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
