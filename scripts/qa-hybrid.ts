/**
 * QA 重放：复用已跑完的记忆树，只重跑问答探针 —— 用于离线对比检索策略。
 * 用法：node scripts/qa-hybrid.ts <runDir> [--sessions N] [--retrieval fts|vec|hybrid]
 * 例：node scripts/qa-hybrid.ts eval/halumem/runs/2026-11-19T21-04-19-543Z --retrieval hybrid
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryFile } from "../packages/core/src/index.ts";
import { LlmClient } from "../eval/llm.ts";
import { toScenario } from "../eval/halumem/adapter.ts";
import { answerProbe } from "../eval/memory/harness.ts";
import { JUDGE_SYSTEM, REFUSE_SYSTEM, judgeUser, refuseUser } from "../eval/memory/prompts.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const runDir = process.argv[2];
if (!runDir || !existsSync(join(runDir, "rec-1"))) throw new Error(`用法: node scripts/qa-hybrid.ts <runDir> [--sessions N] [--retrieval fts|vec|hybrid]`);
const SESSIONS = Number(arg("sessions") ?? "65");
const RETRIEVAL = (arg("retrieval") ?? "hybrid") as "fts" | "vec" | "hybrid";

// 数据集 → 探针（与正式跑同口径）
const { homedir } = await import("node:os");
const { readFile } = await import("node:fs/promises");
const dataPath =
  process.env.HALUMEM_DATA ?? join(homedir(), ".cache", "memory-x", "halumem", "HaluMem-Medium.jsonl");
const rec = JSON.parse((await readFile(dataPath, "utf8")).split("\n").filter(Boolean)[0]!);
const scenario = toScenario(rec, { maxSessions: SESSIONS });

const mf = await MemoryFile.open(join(runDir, "rec-1"));
const llm = LlmClient.fromEnv(arg("model") ?? "glm-5.3-flash");
console.log(`QA 重放：${runDir}\n检索策略：${RETRIEVAL} · ${scenario.probes?.length ?? 0} 题 · 模型 ${llm.model}\n`);

// ---------- 叶子清单（向量侧索引） ----------
interface LeafRow { path: string; text: string }
const leaves: LeafRow[] = [];
const walk = (n: any, path: string) => {
  for (const l of n.leaves) leaves.push({ path, text: l });
  for (const c of n.children) walk(c, path ? `${path}/${c.title}` : c.title);
};
walk(mf.root, "");
console.log(`树：${leaves.length} 叶`);

let vecs: number[][] | null = null;
if (RETRIEVAL !== "fts") {
  vecs = await llm.embed(leaves.map((l) => l.text));
  console.log(`向量索引就绪（${vecs.length} × ${vecs[0]?.length ?? 0} 维）`);
}
const embedCache = new Map<string, number[]>();
const embedQuery = async (q: string): Promise<number[]> => {
  let v = embedCache.get(q);
  if (!v) {
    v = (await llm.embed([q]))[0]!;
    embedCache.set(q, v);
  }
  return v;
};
const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
const norm = (a: number[]): number => Math.sqrt(dot(a, a));

// ---------- 检索：RRF 融合 ----------
function retrieve(question: string, ftsTop: any[], k = 5): string[] {
  const rrf = new Map<string, number>();
  const add = (path: string, rank: number, weight = 1) => rrf.set(path, (rrf.get(path) ?? 0) + weight / (60 + rank));
  if (RETRIEVAL !== "vec") ftsTop.forEach((h, i) => add(h.path, i + 1));
  return [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([p]) => p);
}

async function retrieveHybrid(question: string, k = 5): Promise<string[]> {
  if (RETRIEVAL === "fts") return retrieve(question, mf.search(question, 8), k);
  const qv = await embedQuery(question);
  const qn = norm(qv);
  const scored = leaves
    .map((l, i) => ({ path: l.path, s: dot(qv, vecs![i]!) / (qn * norm(vecs![i]!)) }))
    .sort((a, b) => b.s - a.s);
  if (RETRIEVAL === "vec") {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of scored) {
      if (!seen.has(s.path)) {
        seen.add(s.path);
        out.push(s.path);
        if (out.length >= k) break;
      }
    }
    return out;
  }
  if (RETRIEVAL === "full") {
    // 长上下文流派：不检索，整树进上下文（用顶层节点标题作路径）
    return mf.root.children.map((c: any) => String(c.title));
  }
  if (RETRIEVAL === "union") {
    // FTS top4 ∪ 向量 top3（去重，不挤占）：词面与语义各保底，避免 RRF tie 挤掉单侧唯一命中
    const out: string[] = [];
    const seen = new Set<string>();
    for (const h of mf.search(question, 4)) {
      if (!seen.has(h.path)) {
        seen.add(h.path);
        out.push(h.path);
      }
    }
    for (const s of scored) {
      if (out.length >= 7) break;
      if (!seen.has(s.path)) {
        seen.add(s.path);
        out.push(s.path);
      }
    }
    return out;
  }
  // hybrid：RRF(FTS rank, Vec rank)
  const rrf = new Map<string, number>();
  mf.search(question, 8).forEach((h, i) => rrf.set(h.path, (rrf.get(h.path) ?? 0) + 1 / (60 + i + 1)));
  const seen = new Set<string>();
  let rank = 0;
  for (const s of scored) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    rank++;
    rrf.set(s.path, (rrf.get(s.path) ?? 0) + 1 / (60 + rank));
    if (rank >= 12) break;
  }
  return [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([p]) => p);
}

// ---------- 问答 + 判分（与 harness 相同） ----------
let pass = 0;
let historyUsed = 0;
const byTag: Record<string, { pass: number; total: number }> = {};
const fails: string[] = [];
for (const p of scenario.probes ?? []) {
  const paths = await retrieveHybrid(p.question);
  const ctx = paths.map((path) => mf.renderSection(path) ?? "").join("\n\n---\n\n");
  const { pred, historyUsed: h, historyPath } = await answerProbe(mf, llm, p.question, ctx);
  if (h) {
    historyUsed++;
    console.log(`  [HISTORY] ${p.question.slice(0, 60)} → ${historyPath}`);
  }
  const system = p.kind === "refuse" ? REFUSE_SYSTEM : JUDGE_SYSTEM;
  const user = p.kind === "refuse" ? refuseUser(p.question, pred) : judgeUser(p.question, String(p.answer), pred);
  const verdict = (await llm.chat(system, user, 800)).trim().toUpperCase();
  const ok = verdict.startsWith("CORRECT");
  if (ok) pass++;
  else fails.push(`✗ ${p.question} → 「${pred.slice(0, 120)}」（期望「${p.answer ?? "拒绝"}」）`);
  const b = (byTag[p.tag ?? "?"] ??= { pass: 0, total: 0 });
  b.total++;
  if (ok) b.pass++;
}

console.log(`\n════════ QA 重放结果（${RETRIEVAL}${historyUsed ? ` + HISTORY×${historyUsed}` : ""}）════════`);
let tp = 0, tt = 0;
for (const [tag, b] of Object.entries(byTag)) {
  tp += b.pass; tt += b.total;
  console.log(`${tag.padEnd(28)} ${(b.pass / b.total).toFixed(3)}  (${b.pass}/${b.total})`);
}
console.log(`问答 总体 ${(tp / tt).toFixed(3)}  (${tp}/${tt})`);
console.log(`\n${llm.usageLine()}`);
await (await import("node:fs/promises")).writeFile(
  join(runDir, `qa-replay-${RETRIEVAL}.json`),
  JSON.stringify({ retrieval: RETRIEVAL, byTag, fails }, null, 2),
);
console.log(`失败明细：${join(runDir, `qa-replay-${RETRIEVAL}.json`)}`);
