import { readFile } from "node:fs/promises";
import { MemoryFile } from "../packages/core/src/index.ts";
import { collectLeaves, contentTokens } from "../eval/memory/metrics.ts";

const SANDBOX = process.argv[2]!;
const SUMMARY = process.argv[3]!;
const d = JSON.parse(await readFile(SUMMARY, "utf8"));
const mf = await MemoryFile.open(SANDBOX);
const treeToks = new Set(collectLeaves(mf.root as any).flatMap((l: string) => contentTokens(l)));
console.log(`missed ${d.missedRemember.length} 条：命中token/总数 → 覆盖率 ｜ 未命中词`);
for (const m of d.missedRemember) {
  const w = [...new Set(contentTokens(m))];
  const hit = w.filter((x) => treeToks.has(x));
  const ratio = (hit.length / w.length * 100).toFixed(0);
  const kind = +ratio >= 40 ? "词面差" : "没写 ";
  console.log(`[${kind} ${ratio}% ${hit.length}/${w.length}] ${m.slice(0, 70)}`);
  console.log(`    缺: ${w.filter((x) => !treeToks.has(x)).join(", ")}`);
}
