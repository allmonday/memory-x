/**
 * 评估跑分器：hit@1 / hit@3 / MRR
 *
 * 用法：
 *   npm run eval
 *   node scripts/eval.ts --dir ~/memory-x/memory --file eval/questions.json --topK 5
 *
 * 题集格式（JSON，本地保存不入库）：
 *   [{ "id": "q1", "type": "exact|paraphrase|short2|content",
 *      "query": "用户的自然问法", "expect": "期望命中的节点物化路径" }]
 *
 * 命中判定（子树容忍）：命中路径与期望路径互为祖先/后代即算对——
 * 评估的是"找到记忆版图的正确区域"，不是路径逐字精确。
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryFile } from "../packages/core/src/index.ts";

interface Question {
  id: string;
  type: string;
  query: string;
  expect: string;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const dir = resolve(arg("dir", join(homedir(), "memory-x", "memory")));
const file = resolve(arg("file", "eval/questions.json"));
const topK = Number(arg("topK", "5"));

const questions = JSON.parse(await readFile(file, "utf8")) as Question[];
const mf = await MemoryFile.open(dir);

const subtreeMatch = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

let hit1 = 0;
let hit3 = 0;
let mrr = 0;
const misses: Array<Question & { got: string[] }> = [];

console.log(`评估：${questions.length} 题 · 目录 ${dir} · topK ${topK}\n`);
for (const q of questions) {
  const hits = mf.search(q.query, topK);
  const rank = hits.findIndex((h) => subtreeMatch(h.path, q.expect));
  const ok1 = rank === 0;
  const ok3 = rank >= 0 && rank < 3;
  if (ok1) hit1++;
  if (ok3) hit3++;
  mrr += rank >= 0 ? 1 / (rank + 1) : 0;
  if (!ok3) misses.push({ ...q, got: hits.map((h) => h.path) });
  console.log(
    `${ok3 ? (ok1 ? "●" : "◐") : "○"} [${q.type.padEnd(10)}] ${q.query} → ${rank >= 0 ? `#${rank + 1}` : "MISS"}`,
  );
}

const n = questions.length;
console.log(`\n─────
hit@1: ${(hit1 / n).toFixed(2)}  (${hit1}/${n})
hit@3: ${(hit3 / n).toFixed(2)}  (${hit3}/${n})
MRR:   ${mrr > 0 ? (mrr / n).toFixed(2) : "0.00"}`);

if (misses.length > 0) {
  console.log(`\n失败清单（调参素材）：`);
  for (const m of misses) {
    console.log(`  ✗ [${m.type}] "${m.query}"`);
    console.log(`    期望: ${m.expect}`);
    console.log(`    实得: ${m.got.length ? m.got.join(" | ") : "（空）"}`);
  }
}

const results = {
  timestamp: new Date().toISOString(),
  dir,
  topK,
  n,
  hit1,
  hit3,
  mrr: Number((mrr / n).toFixed(4)),
  misses: misses.map((m) => ({ id: m.id, query: m.query, expect: m.expect, got: m.got })),
};
const outDir = resolve("eval/results");
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `${results.timestamp.replace(/[:.]/g, "-")}.json`);
await writeFile(outFile, JSON.stringify(results, null, 2));
console.log(`\n结果已存 ${outFile}`);
