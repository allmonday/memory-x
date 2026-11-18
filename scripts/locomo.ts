/**
 * LoCoMo 评估器（入口）
 * ====================
 * 见 eval/locomo/README.md。适配层在 eval/locomo/adapter.ts，LLM 客户端在 eval/locomo/llm.ts。
 *
 * 记忆树形状（每段对话一个独立仓）：
 *   root
 *   ├─ 原文            ← 一个原文分支（父节点），其下按 session 分组、每轮一条原话叶子
 *   └─ 结构化          ← 一个结构化分支，其下按 session/topic 挂 LLM 抽取的事实
 *
 * 命中口径（B）：不看 session 路径，改为「检索到的上下文是否覆盖证据句」——
 *   证据句由 qa.evidence 里的 dia_id 取回原话，用内容词重叠度判定是否被覆盖。
 *
 * 用法：
 *   npm run eval:locomo                             # 仅检索（原文分支，零 LLM）
 *   node scripts/locomo.ts --llm-ingest             # 加 LLM 结构化分支
 *   node scripts/locomo.ts --sample 200 --answer    # 端到端（默认含 LLM 结构化 + 问答）
 *   node scripts/locomo.ts --data /path/locomo10.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MemoryFile } from "../packages/core/src/index.ts";
import {
  CATEGORY_NAMES,
  EVAL_CATEGORIES,
  buildRawBranchOutline,
  resolveDataset,
  sanitizeOutline,
  selectQuestions,
  sessions,
  speakers,
  turnTextIndex,
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
const LLM_INGEST = flag("llm-ingest") || (WITH_ANSWER && !flag("raw-ingest"));
/** 推理模型的 reasoning 会吃输出预算，太小会导致 content 为空 */
const INGEST_MAX_TOKENS = Number(arg("ingest-max-tokens") ?? "8000");
/** 证据覆盖判定的内容词重叠阈值（0-1） */
const COVER_MIN = Number(arg("cover-min") ?? "0.7");
/** 分支融合策略：none | raw-first | raw-only | interleave（LLM 建树时默认 raw-first） */
const FUSION = arg("fusion") ?? (LLM_INGEST ? "raw-first" : "none");

const RUN_DIR = resolve("eval/locomo/runs", new Date().toISOString().replace(/[:.]/g, "-"));

/** 归一化：小写、去标点、去停用词后的内容词 */
const STOP = new Set("the a an is are was were be been being of to in on at for with and or but not no do does did this that these those i you he she it we they me him her them my your his its our their as by from what when where who whom which how why".split(" "));
function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !STOP.has(w));
}
/** 证据句是否被上下文覆盖：内容词重叠率 ≥ COVER_MIN */
function covered(evidenceText: string, contextWords: Set<string>): boolean {
  const ev = contentWords(evidenceText);
  if (ev.length === 0) return false;
  let hit = 0;
  for (const w of new Set(ev)) if (contextWords.has(w)) hit++;
  return hit / new Set(ev).size >= COVER_MIN;
}

interface Hit {
  path: string;
}

/**
 * 分支融合：结构化节点短且关键词密集，bm25 会把它们顶到原文前面。
 * 因此检索时先取更大的候选池，再按策略让原文优先。
 *   raw-first  —— 原文全部在前，结构化追加在后（默认，不伤召回）
 *   raw-only   —— 只用原文分支
 *   interleave —— 原文/结构化交替
 */
function fuse(pool: Hit[], topK: number): Hit[] {
  if (FUSION === "none") return pool.slice(0, topK);
  const raw = pool.filter((h) => h.path.startsWith("原文/"));
  const str = pool.filter((h) => h.path.startsWith("结构化/"));
  let out: Hit[];
  if (FUSION === "raw-only") {
    out = raw;
  } else if (FUSION === "interleave") {
    out = [];
    for (let i = 0; i < Math.max(raw.length, str.length); i++) {
      if (raw[i]) out.push(raw[i]!);
      if (str[i]) out.push(str[i]!);
    }
  } else {
    out = [...raw, ...str];
  }
  return out.slice(0, topK);
}

interface Row {
  conv: string;
  q: string;
  cat: number;
  /** 前 k 个命中能覆盖全部证据的最小 k（-1=topK 内未覆盖） */
  coverRank: number;
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
  if (llm) console.log(`LLM：${llm.model}${LLM_INGEST ? "（含结构化 ingest）" : ""}`);

  await mkdir(RUN_DIR, { recursive: true });
  const rows: Row[] = [];
  const total = sel.total;
  const isTty = Boolean(process.stdout.isTTY);
  let done = 0;
  let lastPrint = 0;

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
    const mode = !llm ? "仅检索" : LLM_INGEST ? (WITH_ANSWER ? "结构化 + 问答" : "结构化") : "机械 + 问答";
    console.log(`▶ ${c.sample_id}：${sessions(c).length} sessions · ${qas.length} 题（${mode}）`);

    const mf = await MemoryFile.open(join(RUN_DIR, c.sample_id));
    await mf.applyTree(buildRawBranchOutline(c)); // 原文分支
    if (llm && LLM_INGEST) {
      const all = sessions(c);
      const [a, b] = speakers(c);
      for (let i = 0; i < all.length; i++) {
        const s = all[i]!;
        const extracted = sanitizeOutline(await llm.chat(INGEST_SYSTEM, ingestUser(a, b, s.date, s.turns), INGEST_MAX_TOKENS));
        if (extracted) await mf.applyOutline(`结构化/session-${s.index}`, extracted); // 结构化分支（另一棵树）
        if (isTty) process.stdout.write(`\r  结构化 session ${i + 1}/${all.length} …`.padEnd(90));
      }
      if (isTty) process.stdout.write("\n");
    }

    const idx = turnTextIndex(c);
    for (const q of qas) {
      const pool = mf.search(q.question, FUSION === "none" ? TOP_K : Math.max(TOP_K * 10, 50));
      const hits = fuse(pool, TOP_K);
      // 逐级累积上下文，找覆盖全部证据的最小 k
      const ctxWords = new Set<string>();
      let coverRank = -1;
      const evidence = q.evidence.map((d) => idx.get(d) ?? "").filter(Boolean);
      for (let k = 0; k < hits.length; k++) {
        for (const w of contentWords(mf.renderSection(hits[k]!.path) ?? "")) ctxWords.add(w);
        if (evidence.length > 0 && evidence.every((e) => covered(e, ctxWords))) {
          coverRank = k;
          break;
        }
      }
      const row: Row = { conv: c.sample_id, q: q.question, cat: q.category, coverRank };
      if (WITH_ANSWER && llm && EVAL_CATEGORIES.has(q.category)) {
        const memories = hits.filter((h) => h.path).map((h) => mf.renderSection(h.path) ?? "").join("\n\n---\n\n");
        row.pred = (await llm.chat(ANSWER_SYSTEM, answerUser(memories, q.question))).trim();
        const verdict = await llm.chat(JUDGE_SYSTEM, judgeUser(q.question, q.answer, row.pred));
        row.correct = isCorrect(verdict);
      }
      rows.push(row);
      done++;
      const mark = row.correct === undefined ? (coverRank === 0 ? "●" : coverRank >= 0 ? "◐" : "○") : row.correct ? "✓" : "✗";
      report(c.sample_id, q.category, mark);
    }
    await writeFile(join(RUN_DIR, `${c.sample_id}.json`), JSON.stringify(rows.filter((r) => r.conv === c.sample_id), null, 2));
  }
  if (isTty) process.stdout.write("\n");

  // ---------- 汇总 ----------
  const n = rows.length;
  const c1 = rows.filter((r) => r.coverRank === 0).length;
  const c3 = rows.filter((r) => r.coverRank >= 0 && r.coverRank < 3).length;
  const ck = rows.filter((r) => r.coverRank >= 0).length;
  const mrr = rows.reduce((s, r) => s + (r.coverRank >= 0 ? 1 / (r.coverRank + 1) : 0), 0) / n;
  console.log(`\n════════ 证据覆盖（${n} 题，topK=${TOP_K}，口径 B）════════`);
  console.log(`cover@1 ${(c1 / n).toFixed(3)}  cover@3 ${(c3 / n).toFixed(3)}  cover@${TOP_K} ${(ck / n).toFixed(3)}  MRR ${mrr.toFixed(3)}`);

  let cats: Record<number, { ok: number; n: number }> | undefined;
  if (WITH_ANSWER && llm) {
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
    coverMin: COVER_MIN,
    withAnswer: WITH_ANSWER,
    llmIngest: LLM_INGEST,
    sample: SAMPLE || undefined,
    seed: SAMPLE ? SEED : undefined,
    n,
    coverage: { cover1: c1, cover3: c3, coverk: ck, mrr: Number(mrr.toFixed(4)) },
    jscore: cats ? { byCategory: cats, total: { ok: Object.values(cats).reduce((s, x) => s + x.ok, 0), n: Object.values(cats).reduce((s, x) => s + x.n, 0) } } : undefined,
    usage: llm ? llm.usage : undefined,
    rows,
  };
  const out = join(RUN_DIR, "summary.json");
  await writeFile(out, JSON.stringify(summary, null, 2));
  console.log(`\n结果：${out}`);
}

await main();
