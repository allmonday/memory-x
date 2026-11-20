/**
 * HaluMem → pi-live 评测的数据装载
 * ==============================
 * HaluMem（IAAR-Shanghai，CC-BY-NC-ND-4.0）record = 一个 persona 的完整对话史。
 * loadRecord 展开为 pi-live 所需形态：逐 user turn（原文，无前缀）、黄金点、
 * 更新对（旧值应被新值替换）、probe 题（question_type 打 tag；Memory Boundary=对抗题）。
 * 数据集不落仓库（许可限制），从缓存/上游读取。
 */
export interface HaluMemMemoryPoint {
  index: number;
  memory_content: string;
  memory_type?: string;
  is_update?: string;
  original_memories?: string[];
  timestamp?: string;
  importance?: number;
}
export interface HaluMemQuestion {
  question: string;
  answer: string;
  evidence?: string[];
  difficulty?: string;
  question_type: string;
}
export interface HaluMemSession {
  start_time?: string;
  end_time?: string;
  dialogue: Array<{ role: string; content: string; timestamp?: string }>;
  memory_points?: HaluMemMemoryPoint[];
  questions?: HaluMemQuestion[];
}
export interface HaluMemRecord {
  uuid: string;
  persona_info?: string;
  sessions: HaluMemSession[];
}

export interface Probe {
  question: string;
  answer?: string | null;
  /** 对抗题：材料里没有的信息，应拒绝作答而非编造 */
  refuse?: boolean;
  /** 分类标签（HaluMem question_type），分桶统计 */
  tag?: string;
}

/** 更新对：同一事实的旧表述应被新表述替换（supersede 考核单元） */
export interface ReplacePair {
  old: string;
  neu: string;
}

export interface RecordCase {
  /** user 发言原文（时间序；assistant 轮不喂——pi 会话里由被测 agent 自己生成回复） */
  turns: string[];
  /** 黄金点（非更新）：该被记住的事实 */
  expectRemember: string[];
  /** 更新对：旧值应被替换为新值 */
  expectReplace: ReplacePair[];
  /** 问答探针 */
  probes: Probe[];
}

export function loadRecord(rec: HaluMemRecord, opts: { sessions?: number; qps?: number } = {}): RecordCase {
  const sessions = rec.sessions.slice(0, opts.sessions ?? rec.sessions.length);
  const turns = sessions.flatMap((s) => s.dialogue.filter((t) => t.role === "user").map((t) => t.content));
  const expectRemember: string[] = [];
  const expectReplace: ReplacePair[] = [];
  for (const s of sessions)
    for (const mp of s.memory_points ?? []) {
      if (mp.is_update === "True") {
        for (const old of mp.original_memories ?? []) expectReplace.push({ old, neu: mp.memory_content });
      } else expectRemember.push(mp.memory_content);
    }
  const probes: Probe[] = sessions.flatMap((s) =>
    (s.questions ?? []).slice(0, opts.qps || undefined).map((q) => ({
      question: q.question,
      answer: q.question_type === "Memory Boundary" ? null : q.answer,
      refuse: q.question_type === "Memory Boundary",
      tag: q.question_type,
    })),
  );
  return { turns, expectRemember, expectReplace, probes };
}
