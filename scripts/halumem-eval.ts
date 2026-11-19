/**
 * HaluMem 评估入口
 * =================
 * 用法：
 *   npm run eval:halumem                          # 用缓存/下载的 Medium，评第 1 条记录前 8 个 session
 *   npm run eval:halumem -- --records 2 --sessions 10
 *   npm run eval:halumem -- --mode mechanical     # 机械建树对照
 *
 * 数据集：HaluMem-Medium.jsonl（CC-BY-NC-ND-4.0），不落仓库：
 *   --data <path> > $HALUMEM_DATA > ~/.cache/memory-x/halumem/... > 从 HuggingFace 下载。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LlmClient } from "../eval/llm.ts";
import { runScenario } from "../eval/memory/harness.ts";
import { toScenario, type HaluMemRecord } from "../eval/halumem/adapter.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CACHE = join(homedir(), ".cache", "memory-x", "halumem", "HaluMem-Medium.jsonl");
const URL = "https://huggingface.co/datasets/IAAR-Shanghai/HaluMem/resolve/main/HaluMem-Medium.jsonl";
const RECORDS = Number(arg("records") ?? "1");
const SESSIONS = Number(arg("sessions") ?? "8");
const QPS = Number(arg("qps") ?? "0"); // 每 session 最多几题；0=不限
const MODE = (arg("mode") ?? "llm") as "llm" | "mechanical" | "llm-update" | "turn-agent";
const RUN_DIR = resolve("eval/halumem/runs", new Date().toISOString().replace(/[:.]/g, "-"));

async function datasetPath(): Promise<string> {
  const explicit = arg("data") ?? process.env.HALUMEM_DATA;
  if (explicit) return resolve(explicit);
  if (!existsSync(CACHE)) {
    await mkdir(dirname(CACHE), { recursive: true });
    console.log(`下载 HaluMem-Medium → ${CACHE}`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`下载失败：${res.status}`);
    await writeFile(CACHE, await res.text());
  }
  return CACHE;
}

const path = await datasetPath();
const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim());
const records = lines.slice(0, RECORDS).map((l) => JSON.parse(l) as HaluMemRecord);

const llm = MODE === "mechanical" ? null : LlmClient.fromEnv(arg("model"));
const MODE_LABEL =
  MODE === "turn-agent" ? "Turn 级 agent 仿真" : MODE === "llm-update" ? "LLM 更新感知" : MODE === "llm" ? "LLM 抽取" : "机械建树";
console.log(`数据集：${path}\n模式：${MODE_LABEL} · 记录 ${records.length} · 每记录前 ${SESSIONS} sessions${llm ? ` · 模型 ${llm.model}` : ""}\n`);

await mkdir(RUN_DIR, { recursive: true });
const tagAgg: Record<string, { pass: number; total: number }> = {};
const recalls: number[] = [];
const precisions: number[] = [];
const summaries: unknown[] = [];

for (let i = 0; i < records.length; i++) {
  const rec = records[i]!;
  const scenario = toScenario(rec, { maxSessions: SESSIONS, maxQuestionsPerSession: QPS || undefined, turnLevel: MODE === "turn-agent" });
  const r = await runScenario(scenario, { dir: join(RUN_DIR, `rec-${i + 1}`), llm, mode: MODE });
  summaries.push(r);
  console.log(`▶ 记录 ${i + 1}/${records.length}  ${rec.uuid}  （${Math.min(SESSIONS, rec.sessions.length)}/${rec.sessions.length} sessions · ${scenario.probes?.length ?? 0} 题）`);
  if (r.recall !== undefined) { recalls.push(r.recall); console.log(`  抽取 recall ${r.recall.toFixed(3)}  precision ${r.precision !== undefined ? r.precision.toFixed(3) : "n/a（无更新点）"}`); }
  if (r.precision !== undefined) precisions.push(r.precision);
  if (r.qaTotal) {
    console.log(`  问答 ${r.qaPass}/${r.qaTotal}`);
    for (const [tag, b] of Object.entries(r.byTag ?? {})) {
      console.log(`    ${tag.padEnd(28)} ${b.pass}/${b.total}`);
      const a = (tagAgg[tag] ??= { pass: 0, total: 0 });
      a.pass += b.pass;
      a.total += b.total;
    }
  }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`\n════════ 汇总（${records.length} 记录）════════`);
if (recalls.length) console.log(`抽取 recall    ${avg(recalls).toFixed(3)}`);
if (precisions.length) console.log(`抽取 precision ${avg(precisions).toFixed(3)}  （precision 低 = 旧值未替换 / 记了噪音）`);
for (const r of summaries as Array<{ writeStats?: { adds: number; updates: number; failed: number; searches: number; drills: number } }>)
  if (r.writeStats)
    console.log(
      `写入 ADD ${r.writeStats.adds} · UPDATE ${r.writeStats.updates} · SEARCH ${r.writeStats.searches} · 下钻 ${r.writeStats.drills} · 失败 ${r.writeStats.failed}  （turn-agent 仿真）`,
    );
let tp = 0, tt = 0;
for (const [tag, b] of Object.entries(tagAgg)) { tp += b.pass; tt += b.total; console.log(`问答 ${tag.padEnd(28)} ${(b.pass / b.total).toFixed(3)}  (${b.pass}/${b.total})`); }
if (tt) console.log(`问答 总体 ${(tp / tt).toFixed(3)}  (${tp}/${tt})`);
if (llm) console.log(`\n${llm.usageLine()}`);

const out = join(RUN_DIR, "summary.json");
await writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), path, mode: MODE, sessions: SESSIONS, results: summaries, usage: llm?.usage }, null, 2));
console.log(`\n结果：${out}`);
