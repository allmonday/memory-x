/**
 * HaluMem × pi 真实会话评测（pi-live 模式，PoC）
 * ==============================================
 * 与 turn-agent 仿真的区别：不程序化复刻 extension 行为，而是用 pi SDK 起
 * 真实无头会话——生产 pi-extension + 生产系统提示词 + harness 真实行为
 * （上下文组装、compaction）——逐 user turn 对话，记忆经 MEMORY_X_DIR 指向
 * 沙盒；probe 题在同一会话内提问，判分沿用强模型协议（与 turn-agent 可比）。
 *
 * 用法：
 *   node scripts/halumem-pi-eval.ts                                # 记录1 第1场（默认 glm-5.3-flash + thinking high）
 *   node scripts/halumem-pi-eval.ts --sessions 2                 # 前2场
 *   node scripts/halumem-pi-eval.ts --thinking low               # 调 thinking 档位
 *   node scripts/halumem-pi-eval.ts --model deepseek/deepseek-flash --thinking off   # 换回 flash 关思考
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { MemoryFile } from "../packages/core/src/index.ts";
import { contentTokens, coveredBy } from "../eval/memory/harness.ts";
import { LlmClient } from "../eval/llm.ts";
import { JUDGE_SYSTEM, REFUSE_SYSTEM, judgeUser, refuseUser } from "../eval/memory/prompts.ts";
import type { HaluMemRecord } from "../eval/halumem/adapter.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const RECORD = Number(arg("record") ?? "1");
const SESSIONS = Number(arg("sessions") ?? "1");
const MODEL = arg("model") ?? "zai-coding-cn/glm-5.3-flash";
const THINKING = (arg("thinking") ?? "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const QPS = Number(arg("qps") ?? "0");

// ---------- 沙盒（必须在 extension 模块加载前设置，它在 import 时读 env） ----------
const RUN_DIR = resolve("eval/halumem/runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-pi`);
const SANDBOX = join(RUN_DIR, `rec-${RECORD}`);
process.env.MEMORY_X_DIR = SANDBOX;
await mkdir(SANDBOX, { recursive: true });

// ---------- 数据：记录 N 前 S 场 ----------
const CACHE = join(homedir(), ".cache", "memory-x", "halumem", "HaluMem-Medium.jsonl");
const rec = JSON.parse(
  (await readFile(CACHE, "utf8")).split("\n").filter((l) => l.trim())[RECORD - 1]!,
) as HaluMemRecord;
const sessions = rec.sessions.slice(0, SESSIONS);
const turns = sessions.flatMap((s) => s.dialogue.filter((t) => t.role === "user").map((t) => t.content));
const memoryPoints = sessions.flatMap((s) => s.memory_points ?? []);
const expectRemember = memoryPoints.filter((m) => m.is_update !== "True").map((m) => m.memory_content);
const expectIgnore = memoryPoints.filter((m) => m.is_update === "True").flatMap((m) => m.original_memories ?? []);
const probes = sessions.flatMap((s) =>
  (s.questions ?? []).slice(0, QPS || undefined).map((q) => ({
    question: q.question,
    answer: q.answer,
    refuse: q.question_type === "Memory Boundary",
    tag: q.question_type,
  })),
);
console.log(
  `pi-live：记录${RECORD} 前${SESSIONS}场 · ${turns.length} user turns · 黄金点 ${expectRemember.length}（更新点 ${expectIgnore.length}）· 题 ${probes.length} · 模型 ${MODEL} · thinking ${THINKING}\n沙盒：${SANDBOX}\n`,
);

// ---------- pi 会话（生产 extension + 生产系统提示词；排掉编码工具只留 memory 工具） ----------
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  additionalExtensionPaths: [resolve("packages/pi-extension/index.ts")],
});
await loader.reload();
// 模型解析：MODEL 形如 "deepseek-flash"（默认 deepseek provider）或 "zai-coding-cn/glm-5.3-flash"
const modelRuntime = await ModelRuntime.create();
const [prov, ...id] = MODEL.includes("/") ? MODEL.split("/") : ["deepseek", MODEL];
const model = modelRuntime.getModel(prov, id.join("/"));
if (!model)
  throw new Error(
    `模型未找到：${prov}/${id.join("/")}；可用：` + (await modelRuntime.getAvailable()).map((m) => `${m.provider}/${m.id}`).join(", "),
  );
const { session, extensionsResult } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  model,
  modelRuntime,
  thinkingLevel: THINKING,
  excludeTools: ["bash", "read", "edit", "write", "grep", "find", "ls"],
});
const extErrors = (extensionsResult as any)?.errors ?? (extensionsResult as any)?.warnings ?? [];
if (extErrors.length) console.log("extension 加载告警：", JSON.stringify(extErrors).slice(0, 300));
console.log("活跃工具：", session.getActiveToolNames().join(", "));

// ---------- 事件订阅：memory 工具调用统计 ----------
const toolStats: Record<string, number> = {};
const memoryOps: Array<{ tool: string; path?: string; leaf?: string }> = [];
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
});

// ---------- 写入阶段：逐 turn 真实对话 ----------
const t0 = Date.now();
let sessionTurns = 0;
try {
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`▶ turn ${i + 1}/${turns.length}（${elapsed}min） ${turn.replace(/\n/g, " ").slice(0, 60)}`);
    await session.prompt(turn);
    const reply = session.getLastAssistantText() ?? "";
    sessionTurns++;
    console.log(`  ↳ 回复 ${reply.length} 字符`);
  }

  // ---------- 问答阶段：同一会话内提问 ----------
  const judge = LlmClient.fromEnv(process.env.EVAL_JUDGE_MODEL ?? "glm-5.3", { thinking: "auto" });
  const qaResults: Array<{ tag: string; question: string; gold: string; pred: string; ok: boolean }> = [];
  let pass = 0;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    console.log(`? 题 ${i + 1}/${probes.length} [${p.tag}] ${p.question.slice(0, 70)}`);
    await session.prompt(p.question);
    const pred = (session.getLastAssistantText() ?? "").trim();
    const system = p.refuse ? REFUSE_SYSTEM : JUDGE_SYSTEM;
    const user = p.refuse ? refuseUser(p.question, pred) : judgeUser(p.question, p.answer ?? "", pred);
    const verdict = (await judge.chat(system, user, 800)).trim().toUpperCase();
    const ok = verdict.startsWith("CORRECT");
    if (ok) pass++;
    qaResults.push({ tag: p.tag, question: p.question, gold: p.refuse ? "（拒绝）" : p.answer ?? "", pred: pred.slice(0, 300), ok });
    console.log(`  ↳ ${ok ? "✓" : "✗"} ${pred.replace(/\n/g, " ").slice(0, 90)}`);
  }

  // ---------- 抽取指标（与 harness 同口径） ----------
  const mf = await MemoryFile.open(SANDBOX);
  const leaves: string[] = [];
  const walk = (n: { leaves: string[]; children: any[] }) => {
    leaves.push(...n.leaves);
    for (const c of n.children) walk(c);
  };
  walk(mf.root as any);
  const leafWords = new Set(leaves.flatMap((l) => contentTokens(l)));
  const hitR = expectRemember.filter((x) => coveredBy(x, leafWords));
  const badI = expectIgnore.filter((x) => coveredBy(x, leafWords));
  const recall = expectRemember.length ? hitR.length / expectRemember.length : NaN;
  const precision = expectIgnore.length ? 1 - badI.length / expectIgnore.length : NaN;

  // ---------- 汇总 ----------
  const duration = ((Date.now() - t0) / 60000).toFixed(1);
  const byTag: Record<string, { pass: number; total: number }> = {};
  for (const r of qaResults) {
    const b = (byTag[r.tag] ??= { pass: 0, total: 0 });
    b.total++;
    if (r.ok) b.pass++;
  }
  console.log(`\n════════ pi-live PoC 结果（${duration}min）════════`);
  if (!Number.isNaN(recall)) console.log(`抽取 recall    ${recall.toFixed(3)}  （漏 ${expectRemember.length - hitR.length} 条）`);
  if (!Number.isNaN(precision)) console.log(`抽取 precision ${precision.toFixed(3)}  （旧值残留 ${badI.length} 条）`);
  console.log(`问答 ${pass}/${probes.length}`);
  for (const [tag, b] of Object.entries(byTag)) console.log(`  ${tag.padEnd(28)} ${b.pass}/${b.total}`);
  console.log(`memory 工具调用：`, JSON.stringify(toolStats));
  console.log(`叶子总数 ${leaves.length}`);

  const out = join(RUN_DIR, "summary.json");
  await writeFile(
    out,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(), mode: "pi-live", model: MODEL, record: RECORD, sessions: SESSIONS,
        recall, precision, qaPass: pass, qaTotal: probes.length, byTag, qaResults,
        toolStats, memoryOps, leafCount: leaves.length, durationMin: Number(duration),
      },
      null, 2,
    ),
  );
  console.log(`\n结果：${out}`);
} finally {
  session.dispose();
}
