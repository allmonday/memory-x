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

// ---------- LLM ingest（把一段对话整理成记忆树分支） ----------

export const INGEST_SYSTEM = [
  "你负责把一段两人的日常对话整理成长期记忆树的一个分支。",
  "只保留有长期价值的事实（人的偏好、经历、关系、计划、重要日期、地点、数字等），去掉寒暄与无信息量内容。",
  "**用与对话相同的语言输出**（英文对话 → 英文事实），并尽量沿用原对话中的关键词、人名、日期、数字、缩写（便于后续检索命中）。",
  "不要把按人名分组——**绝不用人名（如 Caroline/Melanie）或 '人物' 作标题**；若分组，标题必须是描述性主题（如 'Painting & hobbies'、'Career plans'、'Family'）；内容单一则直接列事实、不分组。",
  "绝不编造。",
  "用 Markdown 大纲输出，只允许两种行：",
  "  - 主题行（可选）：以 '### ' 开头，描述性主题",
  "  - 事实行：以 '- ' 开头，一条一个事实（人名写在事实句子里）",
  "不要输出任何其它文字、解释或代码块。",
].join("\n");

export function ingestUser(
  speakerA: string,
  speakerB: string,
  date: string | undefined,
  turns: Array<{ dia_id: string; speaker: string; text: string }>,
): string {
  const lines = turns.map((t) => `[${t.dia_id}] ${t.speaker}: ${t.text}`).join("\n");
  return `对话者：${speakerA} 与 ${speakerB}\n时间：${date ?? "（未知）"}\n\n对话内容：\n${lines}\n\n请整理成记忆大纲。`;
}
