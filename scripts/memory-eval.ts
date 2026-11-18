/**
 * 自建记忆评估入口
 * =================
 * 用法：
 *   npm run eval:memory                                   # 用示例场景，LLM 抽取 + 问答
 *   node scripts/memory-eval.ts --mode mechanical         # 机械建树（零 LLM 抽取）
 *   node scripts/memory-eval.ts --file my.json --filter update-1
 *
 * 场景文件格式见 eval/memory/README.md。沙盒目录 eval/memory/runs/<时间戳>/<场景>/，独立于真实记忆。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LlmClient } from "../eval/llm.ts";
import { runScenario, type Result, type Scenario } from "../eval/memory/harness.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = resolve(arg("file") ?? "eval/memory/scenarios.example.json");
const mode = (arg("mode") ?? "llm") as "llm" | "mechanical";
const filter = arg("filter");
const RUN_DIR = resolve("eval/memory/runs", new Date().toISOString().replace(/[:.]/g, "-"));

const all = JSON.parse(await readFile(file, "utf8")) as Scenario[];
const scenarios = filter ? all.filter((s) => s.id === filter) : all;
if (scenarios.length === 0) throw new Error(`没有匹配的场景（file=${file}, filter=${filter ?? "-"}）`);

const llm = mode === "llm" ? LlmClient.fromEnv(arg("model")) : null;
console.log(`场景文件：${file}\n模式：${mode === "llm" ? "LLM 抽取" : "机械建树"} · 场景数 ${scenarios.length}${llm ? ` · 模型 ${llm.model}` : ""}\n`);

await mkdir(RUN_DIR, { recursive: true });
const results: Result[] = [];
for (const s of scenarios) {
  const r = await runScenario(s, { dir: join(RUN_DIR, s.id), llm, mode });
  results.push(r);
  const parts: string[] = [];
  if (r.recall !== undefined) parts.push(`recall ${r.recall.toFixed(2)}`);
  if (r.precision !== undefined) parts.push(`precision ${r.precision.toFixed(2)}`);
  if (r.qaTotal) parts.push(`问答 ${r.qaPass}/${r.qaTotal}`);
  console.log(`● ${s.id.padEnd(18)} [${r.competency}] ${parts.join("  ")}`);
  for (const d of r.details) console.log(`    ${d}`);
}

// ---------- 汇总 ----------
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const rec = avg(results.filter((r) => r.recall !== undefined).map((r) => r.recall!));
const prec = avg(results.filter((r) => r.precision !== undefined).map((r) => r.precision!));
const qaPass = results.reduce((s, r) => s + (r.qaPass ?? 0), 0);
const qaTotal = results.reduce((s, r) => s + (r.qaTotal ?? 0), 0);
console.log(`\n════════ 汇总（${results.length} 场景）════════`);
if (!Number.isNaN(rec)) console.log(`抽取 recall    ${rec.toFixed(3)}`);
if (!Number.isNaN(prec)) console.log(`抽取 precision ${prec.toFixed(3)}`);
if (qaTotal) console.log(`问答正确       ${(qaPass / qaTotal).toFixed(3)}  (${qaPass}/${qaTotal})`);
if (llm) console.log(`\n${llm.usageLine()}`);

const out = join(RUN_DIR, "summary.json");
await writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), file, mode, results, usage: llm?.usage }, null, 2));
console.log(`\n结果：${out}`);
