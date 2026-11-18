/**
 * LoCoMo 评估器（入口）
 * ====================
 * 见 eval/locomo/README.md。适配层在 eval/locomo/adapter.ts，LLM 客户端在 eval/locomo/llm.ts。
 *
 * 用法：
 *   npm run eval:locomo                             # 仅检索（确定性、零 LLM）
 *   node scripts/locomo.ts --sample 200 --answer    # 分层抽 ~200 题做端到端（回答+判分）
 *   node scripts/locomo.ts --conv conv-26 --limit 20 --topK 5
 *   node scripts/locomo.ts --data /path/to/locomo/data/locomo10.json   # 复用本地数据集
 *
 * 数据集位置：--data > $LOCOMO_DATA > ~/.cache/memory-x/locomo/locomo10.json > 下载。
 * 结果写入 eval/locomo/runs/<时间戳>/（gitignore）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MemoryFile } from "../packages/core/src/index.ts";
import {
  CATEGORY_NAMES,
  EVAL_CATEGORIES,
  buildOutline,
  goldSessions,
  resolveDataset,
  sanitizeOutline,
  selectQuestions,
  sessionCount,
  sessions,
  speakers,
  type QA,
} from "../eval/locomo/adapter.ts";
import { LlmClient } from "../eval/locomo/llm.ts";
import { ANSWER_SYSTEM, INGEST_SYSTEM, JUDGE_SYSTEM, answerUser, ingestUser, isCorrect, judgeUser } from "../eval/locomo/prompts.ts";

// ---------- CLI ----------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const TOP_K = Number(arg("topK") ?? "5");
const LIMIT = Number(arg("limit") ?? "0");
const SAMPLE = Number(arg("sample") ?? "0");
const SEED = Number(arg("seed") ?? "1");
const CONV = arg("conv");
const WITH_ANSWER = flag("answer");
// 建树：默认机械映射；--llm-ingest 显式开启；--answer 默认含 LLM 建树（--raw-ingest 可退回机械）
const LLM_INGEST = flag("llm-ingest") || (WITH_ANSWER && !flag("raw-ingest"));
// 推理模型（如 deepseek-v4-1-flash）的 reasoning 会吃掉预算，太小会导致 content 为空
const INGEST_MAX_TOKENS = Number(arg("ingest-max-tokens") ?? "8000");

const RUN_DIR = resolve("eval/locomo/runs", new Date().toISOString().replace(/[:.]/g, "-"));

interface Row {
  conv: string;
  q: string;
  cat: number;
  rank: number; // 首个 gold session 在 topK 的名次（-1=miss）
  pred?: string;
  correct?: boolean;
}

async function main(): Promise<void> {
  const { path: dataPath, data } = await resolveDataset(arg("data"));
  console.log(`数据集：${dataPath}`);
  const convs = CONV ? data.filter((c) => c.sample_id === CONV) : data;
  if (convs.length === 0) throw new Error(`找不到会话 ${CONV}`);

  const sel = selectQuestions(convs, { sample: SAMPLE, limit: LIMIT, seed: SEED });
  if (SAMPLE > 0) {
    const d = [...sel.dist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `cat${k}:${v}`).join(" ");
    console.log(`分层抽样 ${sel.total} 题（seed=${SEED}）→ ${d}`);
  }

  const llm = WITH_ANSWER || LLM_INGEST ? LlmClient.fromEnv(arg("model")) : null;
  if (llm) console.log(`LLM：${llm.model}${LLM_INGEST ? "（含建树 ingest）" : ""}`);

  await mkdir(RUN_DIR, { recursive: true });
  const rows: Row[] = [];
  const total = sel.total;
  const isTty = Boolean(process.stdout.isTTY);
  let done = 0;
  let lastPrint = 0;

  // 进度：TTY 下原地刷新；非 TTY（重定向）每 25 题打一行，避免刷屏
  const report = (conv: string, cat: number, mark: string) => {
    const pct = ((done / total) * 100).toFixed(1);
    const line = `[${String(done).padStart(4)}/${total}] ${pct.padStart(5)}%  ${mark}  ${conv} · ${CATEGORY_NAMES[cat] ?? cat}`;
    if (isTty) process.stdout.write(`\r${line.padEnd(90)}`);
    else if (done === total || done - lastPrint >= 25) {
      console.log(line);
      lastPrint = done;
    }
  };

  console.log(`共 ${total} 题 · topK=${TOP_K}${WITH_ANSWER ? " · 端到端" : " · 仅检索"}`);
  for (const c of convs) {
    const qas: QA[] = sel.byConv.get(c.sample_id) ?? [];
    if (qas.length === 0) continue;
    if (isTty && done > 0) process.stdout.write("\n");
    const mode = !llm ? "仅检索" : LLM_INGEST ? (WITH_ANSWER ? "LLM 建树 + 问答" : "LLM 建树") : "机械建树 + LLM 问答";
    console.log(`▶ ${c.sample_id}：${sessionCount(c.conversation)} sessions · ${qas.length} 题（${mode}）`);
    const mf = await MemoryFile.open(join(RUN_DIR, c.sample_id));
    await mf.applyTree(buildOutline(c)); // 骨架：session 节点 + 轮次叶子
    if (llm && LLM_INGEST) {
      const all = sessions(c);
      const [a, b] = speakers(c);
      for (let i = 0; i < all.length; i++) {
        const s = all[i]!;
        const extracted = sanitizeOutline(await llm.chat(INGEST_SYSTEM, ingestUser(a, b, s.date, s.turns), INGEST_MAX_TOKENS));
        // 保留 session 日期叶子（时间题需要），再接 LLM 抽取的事实/主题
        const frag = [s.date ? `- [date] ${s.date}` : "", extracted].filter(Boolean).join("\n");
        if (frag) await mf.applyOutline(`session-${s.index}`, frag);
        if (isTty) process.stdout.write(`\r  整理记忆 session ${i + 1}/${all.length} …`.padEnd(90));
      }
      if (isTty) process.stdout.write("\n");
    }

    for (const q of qas) {
      const hits = mf.search(q.question, TOP_K);
      const gold = goldSessions(q);
      const rank = hits.findIndex((h) => [...gold].some((g) => h.path === g || h.path.startsWith(`${g}/`)));
      const row: Row = { conv: c.sample_id, q: q.question, cat: q.category, rank };
      if (WITH_ANSWER && llm && EVAL_CATEGORIES.has(q.category)) {
        const memories = hits.filter((h) => h.path).map((h) => mf.renderSection(h.path) ?? "").join("\n\n---\n\n");
        row.pred = (await llm.chat(ANSWER_SYSTEM, answerUser(memories, q.question))).trim();
        const verdict = await llm.chat(JUDGE_SYSTEM, judgeUser(q.question, q.answer, row.pred));
        row.correct = isCorrect(verdict);
      }
      rows.push(row);
      done++;
      const mark = row.correct === undefined ? (rank === 0 ? "●" : rank >= 0 ? "◐" : "○") : row.correct ? "✓" : "✗";
      report(c.sample_id, q.category, mark);
    }
    await writeFile(join(RUN_DIR, `${c.sample_id}.json`), JSON.stringify(rows.filter((r) => r.conv === c.sample_id), null, 2));
  }
  if (isTty) process.stdout.write("\n");

  // ---------- 汇总 ----------
  const n = rows.length;
  const hit1 = rows.filter((r) => r.rank === 0).length;
  const hit3 = rows.filter((r) => r.rank >= 0 && r.rank < 3).length;
  const hitk = rows.filter((r) => r.rank >= 0).length;
  const mrr = rows.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0) / n;
  console.log(`\n════════ 检索（${n} 题，topK=${TOP_K}）════════`);
  console.log(`hit@1 ${(hit1 / n).toFixed(3)}  hit@3 ${(hit3 / n).toFixed(3)}  hit@${TOP_K} ${(hitk / n).toFixed(3)}  MRR ${mrr.toFixed(3)}`);

  let cats: Record<number, { ok: number; n: number }> | undefined;
  if (llm) {
    console.log(`\n════════ 端到端 J-score（LLM 判分，仅类 1-4）════════`);
    cats = {};
    let tot = 0;
    let ok = 0;
    for (const cat of [1, 2, 3, 4]) {
      const rs = rows.filter((r) => r.cat === cat && r.correct !== undefined);
      if (rs.length === 0) continue;
      const c = rs.filter((r) => r.correct).length;
      cats[cat] = { ok: c, n: rs.length };
      tot += rs.length;
      ok += c;
      console.log(`  cat${cat} ${CATEGORY_NAMES[cat]!.padEnd(11)} ${(c / rs.length).toFixed(3)}  (${c}/${rs.length})`);
    }
    console.log(`  ${"总体".padEnd(15)} ${(ok / tot).toFixed(3)}  (${ok}/${tot})`);
    console.log(`\n${llm.usageLine()}`);
  }

  const summary = {
    timestamp: new Date().toISOString(),
    dataset: dataPath,
    topK: TOP_K,
    withAnswer: WITH_ANSWER,
    sample: SAMPLE || undefined,
    seed: SAMPLE ? SEED : undefined,
    n,
    retrieval: { hit1, hit3, hitk, mrr: Number(mrr.toFixed(4)) },
    jscore: cats ? { byCategory: cats, total: { ok: Object.values(cats).reduce((s, x) => s + x.ok, 0), n: Object.values(cats).reduce((s, x) => s + x.n, 0) } } : undefined,
    usage: llm ? llm.usage : undefined,
    rows,
  };
  const out = join(RUN_DIR, "summary.json");
  await writeFile(out, JSON.stringify(summary, null, 2));
  console.log(`\n结果：${out}`);
}

await main();
