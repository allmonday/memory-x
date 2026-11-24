/**
 * pi-live 评测共享 runner（数据集无关的唯一跑法）
 * ==============================================
 * 通过 pi SDK 起真实无头会话——生产 pi-extension + 生产系统提示词 + harness
 * 真实行为（上下文组装、compaction）——逐 user turn 对话，记忆经 MEMORY_X_DIR
 * 指向沙盒；probe 题在同一会话内提问；判分与被测模型分流（强模型判分）。
 *
 * 由 scripts/halumem-eval.ts（HaluMem）与 scripts/locomo-eval.ts（LoCoMo）共用；
 * 两边口径完全一致，避免拷贝漂移。
 *
 * 注意：pi-extension 在模块加载时读 MEMORY_X_DIR（一进程一沙盒）——本函数
 * 在构造 loader 前设置它，因此每个进程只能跑一个案例；跨案例并行靠多进程
 * （对话级独立沙盒 → 并行与串行口径完全等价）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { MemoryFile } from "../../packages/core/src/index.ts";
import { collectLeaves, recallScore, replacePrecision } from "../memory/metrics.ts";
import { LlmClient } from "../llm.ts";
import { JUDGE_SYSTEM, REFUSE_SYSTEM, judgeUser, refuseUser } from "../memory/prompts.ts";
import type { Probe, RecordCase } from "./types.ts";

export interface UsageStats {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiLiveOptions {
  /** 记忆沙盒绝对路径（= MEMORY_X_DIR；每案例独立，不碰真实记忆） */
  sandbox: string;
  /** summary.json 落盘目录 */
  runDir: string;
  /** 被测模型 "provider/id" 或裸名（deepseek 默认）；判分员另走 EVAL_* env */
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 判分模型（默认 EVAL_JUDGE_MODEL → glm-5.3，thinking auto） */
  judgeModel?: string;
  /** 开场框架声明（replay 保真度的一部分：交代对话来源与身份），首 turn 前注入 */
  opening?: string;
  /** 语言声明（实验用，如 "en"；默认不注入，保持正式口径） */
  lang?: string;
  /** summary.json 额外字段（dataset/record/conv 等） */
  meta?: Record<string, unknown>;
}

export interface PiLiveSummary {
  timestamp: string;
  mode: "pi-live";
  model: string;
  thinking: string;
  recall: number;
  missedRemember: string[];
  precision: number;
  stale: Array<{ old: string; neu: string; leaf: string }>;
  qaPass: number;
  qaTotal: number;
  byTag: Record<string, { pass: number; total: number }>;
  qaResults: Array<Record<string, unknown>>;
  toolStats: Record<string, number>;
  memoryOps: Array<{ tool: string; path?: string; leaf?: string }>;
  leafCount: number;
  durationMin: number;
  /** 被测 agent 的 token 用量（message_end 事件累计） */
  usage: UsageStats;
  /** 判分员 token 用量 */
  judgeUsage: UsageStats;
  [meta: string]: unknown;
}

export async function runPiLive(record: RecordCase, opts: PiLiveOptions): Promise<PiLiveSummary> {
  // ---------- 沙盒（必须在 extension 模块加载前设置，它在 import 时读 env） ----------
  process.env.MEMORY_X_DIR = opts.sandbox;
  await mkdir(opts.sandbox, { recursive: true });

  // ---------- pi 会话（生产 extension + 生产系统提示词；排掉编码工具只留 memory 工具） ----------
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    additionalExtensionPaths: [resolve("packages/pi-extension/index.ts")],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create();
  const [prov, ...id] = opts.model.includes("/") ? opts.model.split("/") : ["deepseek", opts.model];
  const model = modelRuntime.getModel(prov, id.join("/"));
  if (!model)
    throw new Error(
      `模型未找到：${prov}/${id.join("/")}；可用：` +
        (await modelRuntime.getAvailable()).map((m) => `${m.provider}/${m.id}`).join(", "),
    );
  const { session, extensionsResult } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    model,
    modelRuntime,
    thinkingLevel: opts.thinking,
    excludeTools: ["bash", "read", "edit", "write", "grep", "find", "ls"],
  });
  const extErrors = (extensionsResult as any)?.errors ?? (extensionsResult as any)?.warnings ?? [];
  if (extErrors.length) console.log("extension 加载告警：", JSON.stringify(extErrors).slice(0, 300));
  console.log("活跃工具：", session.getActiveToolNames().join(", "));

  // ---------- 事件订阅：工具调用统计 + token 用量 ----------
  const toolStats: Record<string, number> = {};
  const memoryOps: Array<{ tool: string; path?: string; leaf?: string }> = [];
  const usage: UsageStats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  session.subscribe((ev: any) => {
    if (ev.type === "tool_execution_start") {
      const name: string = ev.toolName ?? ev.tool ?? "";
      if (name) toolStats[name] = (toolStats[name] ?? 0) + 1;
      if (name.startsWith("memory_")) {
        const input = ev.input ?? ev.arguments ?? ev.toolInput ?? {};
        memoryOps.push({ tool: name, path: input.path, leaf: (input.leaf ?? input.content ?? input.note ?? "").slice?.(0, 120) });
      }
    }
    if (ev.type === "compaction_end") toolStats["__compaction__"] = (toolStats["__compaction__"] ?? 0) + 1;
    if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
      usage.calls++;
      usage.input += ev.message.usage.input ?? 0;
      usage.output += ev.message.usage.output ?? 0;
      usage.cacheRead += ev.message.usage.cacheRead ?? 0;
      usage.cacheWrite += ev.message.usage.cacheWrite ?? 0;
    }
  });

  // ---------- 写入阶段：逐 turn 真实对话（带对话日期：机械日期戳与题目 as-of 日期对齐） ----------
  if (opts.opening) {
    console.log(`◆ 开场声明：${opts.opening.replace(/\n/g, " ")}`);
    await session.prompt(opts.opening);
  }
  if (opts.lang) {
    const LANG_NAME: Record<string, string> = { en: "English", zh: "Chinese", ja: "Japanese" };
    const ln = LANG_NAME[opts.lang] ?? opts.lang;
    const decl = `Important: conduct this entire conversation in ${ln}, and store ALL memory entries — leaf facts, node titles, notes, and summaries — in ${ln}.`;
    console.log(`◆ 语言声明：${decl}`);
    await session.prompt(decl);
  }
  const t0 = Date.now();
  try {
    const turns = record.turns;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      process.env.MEMORY_X_DATE = turn.date ?? ""; // withDate 优先用显式日期（无效值回退今天）
      const prompt = turn.date ? `[${turn.date}] ${turn.content}` : turn.content;
      const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`▶ turn ${i + 1}/${turns.length}（${elapsed}min） ${prompt.replace(/\n/g, " ").slice(0, 60)}`);
      await session.prompt(prompt);
      const reply = session.getLastAssistantText() ?? "";
      console.log(`  ↳ 回复 ${reply.length} 字符`);
    }
    delete process.env.MEMORY_X_DATE; // QA 阶段不再指定日期

    // ---------- 问答阶段：同一会话内提问 ----------
    const judge = LlmClient.fromEnv(opts.judgeModel ?? process.env.EVAL_JUDGE_MODEL ?? "glm-5.3", { thinking: "auto" });
    const qaResults: Array<Record<string, unknown>> = [];
    let pass = 0;
    for (let i = 0; i < record.probes.length; i++) {
      const p: Probe = record.probes[i]!;
      console.log(`? 题 ${i + 1}/${record.probes.length} [${p.tag}] ${p.question.slice(0, 70)}`);
      await session.prompt(p.question);
      const pred = (session.getLastAssistantText() ?? "").trim();
      const system = p.refuse ? REFUSE_SYSTEM : JUDGE_SYSTEM;
      const user = p.refuse ? refuseUser(p.question, pred) : judgeUser(p.question, p.answer ?? "", pred);
      const verdict = (await judge.chat(system, user, 800)).trim().toUpperCase();
      const ok = verdict.startsWith("CORRECT");
      if (ok) pass++;
      const row: Record<string, unknown> = {
        tag: p.tag, question: p.question, gold: p.refuse ? "（拒绝）" : p.answer ?? "",
        pred: pred.slice(0, 300), ok,
      };
      if (p.evidence) row.evidence = p.evidence;
      if (p.adversarialAnswer) row.adversarialAnswer = p.adversarialAnswer;
      qaResults.push(row);
      console.log(`  ↳ ${ok ? "✓" : "✗"} ${pred.replace(/\n/g, " ").slice(0, 90)}`);
    }

    // ---------- 写入侧指标（金标缺失的数据集自动跳过：NaN 守卫） ----------
    const mf = await MemoryFile.open(opts.sandbox);
    const leaves = collectLeaves(mf.root as any);
    const { recall, missed } = recallScore(leaves, record.expectRemember);
    const { precision, stale } = replacePrecision(leaves, record.expectReplace);

    // ---------- 汇总 ----------
    const duration = ((Date.now() - t0) / 60000).toFixed(1);
    const byTag: Record<string, { pass: number; total: number }> = {};
    for (const r of qaResults) {
      const tag = String(r.tag);
      const b = (byTag[tag] ??= { pass: 0, total: 0 });
      b.total++;
      if (r.ok) b.pass++;
    }
    console.log(`\n════════ pi-live 结果（${duration}min）════════`);
    console.log(`问答            ${pass}/${record.probes.length}${record.probes.length ? ` = ${(pass / record.probes.length).toFixed(3)}` : ""}`);
    for (const [tag, b] of Object.entries(byTag)) console.log(`  ${tag.padEnd(28)} ${b.pass}/${b.total}`);
    if (!Number.isNaN(recall)) console.log(`抽取 recall    ${recall.toFixed(3)}  （漏 ${missed.length} 条）`);
    if (!Number.isNaN(precision)) console.log(`抽取 precision ${precision.toFixed(3)}（叶级修正；真过期叶子 ${stale.length}/${record.expectReplace.length}）`);
    for (const s of stale.slice(0, 5))
      console.log(`  ✗ 过期叶子: ${s.leaf.slice(0, 80)}\n     旧值应为: ${(s.neu ?? "").slice(0, 80)}`);
    console.log(`memory 工具调用：`, JSON.stringify(toolStats));
    console.log(`叶子总数 ${leaves.length}`);
    console.log(
      `被测用量：${usage.calls} 次响应 · input ${usage.input.toLocaleString()} · output ${usage.output.toLocaleString()} · cacheRead ${usage.cacheRead.toLocaleString()} · cacheWrite ${usage.cacheWrite.toLocaleString()}`,
    );
    console.log(`判分用量：${judge.usageLine()}`);

    const summary: PiLiveSummary = {
      ...(opts.meta ?? {}),
      timestamp: new Date().toISOString(), mode: "pi-live", model: opts.model, thinking: opts.thinking,
      recall, missedRemember: missed, precision, stale, qaPass: pass, qaTotal: record.probes.length,
      byTag, qaResults, toolStats, memoryOps, leafCount: leaves.length, durationMin: Number(duration),
      usage, judgeUsage: judge.usage,
    };
    const out = join(opts.runDir, "summary.json");
    await writeFile(out, JSON.stringify(summary, null, 2));
    console.log(`\n结果：${out}`);
    return summary;
  } finally {
    session.dispose();
  }
}
