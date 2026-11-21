// 口径等价性实验：分片树 vs 合并树（串行等价）重放 recall
import { readFile } from "node:fs/promises";
import { MemoryFile } from "../packages/core/src/index.ts";
import { collectLeaves, recallScore } from "../eval/memory/metrics.ts";
import { loadRecord } from "../eval/halumem/adapter.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const RUNS = "eval/halumem/runs";
const A = `${RUNS}/2026-11-21T02-19-03-051Z-pi/rec-1`;
const B = `${RUNS}/2026-11-21T02-19-05-022Z-pi/rec-1-off4`;

const leavesA = collectLeaves((await MemoryFile.open(A)).root as any);
const leavesB = collectLeaves((await MemoryFile.open(B)).root as any);
console.log(`分片A树 ${leavesA.length} 叶 · 分片B树 ${leavesB.length} 叶`);

// B 的黄金点（重放需要原始 expect——从 summary 拿 missed，从 adapter 重建全集）
const CACHE = join(homedir(), ".cache", "memory-x", "halumem", "HaluMem-Medium.jsonl");
const rec = JSON.parse((await readFile(CACHE, "utf8")).split("\n").filter(l => l.trim())[0]!);
const full = loadRecord(rec, { sessions: 8 });
const partB = loadRecord(rec, { sessions: 4, offset: 4 });
console.log(`全集8场黄金点 ${full.expectRemember.length} · B切片黄金点 ${partB.expectRemember.length}`);

console.log("\n== B 的 24 黄金点在三种树上的 recall ==");
console.log(`仅B树（本轮实际口径）: ${recallScore(leavesB, partB.expectRemember).recall.toFixed(3)}`);
console.log(`A+B合并树（串行等价） : ${recallScore([...leavesA, ...leavesB], partB.expectRemember).recall.toFixed(3)}`);
const m = recallScore([...leavesA, ...leavesB], partB.expectRemember);
console.log(`合并后仍漏 ${m.missed.length} 条`);

console.log("\n== 全 8 场黄金点（对照串行 --sessions 8 口径）== ");
console.log(`合并树全量: ${recallScore([...leavesA, ...leavesB], full.expectRemember).recall.toFixed(3)}（本轮分片合并口径 0.837）`);
