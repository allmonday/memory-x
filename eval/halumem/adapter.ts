/**
 * HaluMem → 本框架的场景适配层
 * ============================
 * HaluMem（IAAR-Shanghai，CC-BY-NC-ND-4.0）是操作级的记忆幻觉基准，结构天生对上我们的三阶段：
 *   - 每个 session 的 `memory_points`  → 抽取的黄金点（completeness）+ 幻觉检查
 *   - `is_update=True` + `original_memories` → 更新/supersede（旧值应被替换）
 *   - 每个 session 的 `questions`（带 question_type）→ 召回/多跳/冲突/边界（拒绝）
 *
 * 映射约定：一个 session = 一条 observation（整段对话）；问题按 question_type 打 tag。
 * turnLevel: true 时改为逐 turn 展开（id 形如 s3-t5），供 turn-agent 仿真模式使用。
 * 数据集不落仓库（许可限制），从缓存/上游读取。
 */
import type { Observation, Probe, Scenario } from "../memory/harness.ts";

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

export interface AdapterOpts {
  maxSessions?: number;
  maxQuestionsPerSession?: number;
  /** 逐 turn 展开 observation（turn-agent 仿真用） */
  turnLevel?: boolean;
}

/** HaluMem 记录 → 我们的 Scenario */
export function toScenario(rec: HaluMemRecord, opts: AdapterOpts = {}): Scenario {
  const sessions = rec.sessions.slice(0, opts.maxSessions ?? rec.sessions.length);
  const observations: Observation[] = [];
  const expectRemember: string[] = [];
  const expectIgnore: string[] = [];
  const probes: Probe[] = [];

  sessions.forEach((s, i) => {
    if (opts.turnLevel) {
      // 提速：只喂 user turn（assistant 几乎全是对用户发言的复述/夸奖，无新事实）
      s.dialogue.forEach((t, j) => {
        if (t.role !== "user") return;
        observations.push({ id: `s${i + 1}-t${j + 1}`, date: t.timestamp ?? s.end_time, text: `${t.role}: ${t.content}` });
      });
    } else {
      const text = s.dialogue.map((t) => `${t.role}: ${t.content}`).join("\n");
      observations.push({ id: `s${i + 1}`, date: s.end_time, text });
    }
    for (const mp of s.memory_points ?? []) {
      expectRemember.push(mp.memory_content);
      if (mp.is_update === "True") expectIgnore.push(...(mp.original_memories ?? []));
    }
    const qs = (s.questions ?? []).slice(0, opts.maxQuestionsPerSession ?? Infinity);
    for (const q of qs) {
      const refuse = q.question_type === "Memory Boundary";
      probes.push({ question: q.question, answer: refuse ? null : q.answer, kind: refuse ? "refuse" : "answer", tag: q.question_type });
    }
  });

  return {
    id: rec.uuid,
    title: rec.persona_info?.slice(0, 60),
    competency: "extraction",
    ingest: "llm",
    observations,
    expectRemember,
    expectIgnore,
    probes,
  };
}
