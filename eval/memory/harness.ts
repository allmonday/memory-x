/**
 * 自建记忆评估框架 —— 场景驱动、操作级评分
 * ==========================================
 * 参考：
 *   - HaluMem（操作级）：把评测拆到「抽取 / 更新 / 问答」三个阶段
 *   - MemoryAgentBench：能力维度（准确检索、冲突消解、长程理解）
 *
 * 每个场景 = 一段「观察材料」，运行器把它写进 memory-x 沙盒（LLM 抽取或机械），
 * 再对结果评分：
 *   - extraction：期望记住的记住了吗（recall）、期望忽略的没被记吗（precision）
 *   - update / recall / answer：靠 probe 问答（LLM 判分）+ 抽取检查共同判定
 * 沙盒是独立目录，绝不碰真实记忆。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MemoryFile, tocDigest } from "../../packages/core/src/index.ts";
import { LlmClient, type Usage } from "../llm.ts";
import { AGENT_WRITE_SYSTEM, ANSWER_SYSTEM, EXTRACT_SYSTEM, HISTORY_RULE, JUDGE_SYSTEM, REFUSE_SYSTEM, SUPERSEDE_SYSTEM, agentWriteUser, answerUser, extractUser, judgeUser, refuseUser, supersedeUser } from "./prompts.ts";

export interface Observation {
  id?: string;
  date?: string;
  text: string;
}
export interface Probe {
  question: string;
  answer?: string | null;
  /** answer=正常问答；refuse=应该拒绝/说不知道（对抗题） */
  kind?: "answer" | "refuse";
  /** 分类标签（如 HaluMem 的 question_type），用于分桶统计 */
  tag?: string;
}
export interface Scenario {
  id: string;
  title?: string;
  competency: "extraction" | "update" | "recall" | "answer";
  ingest?: "llm" | "mechanical";
  observations: Observation[];
  /** 抽取：期望被记住的要点 */
  expectRemember?: string[];
  /** 抽取：期望不被记的噪音 */
  expectIgnore?: string[];
  /** 召回/问答探针 */
  probes?: Probe[];
}

/** 写入操作统计（turn-agent 仿真用） */
export interface WriteStats {
  adds: number;
  updates: number;
  failed: number;
  /** 两阶段 SEARCH 协议触发次数 */
  searches: number;
  /** 自动下钻（写入已存在路径前附节点现状）次数 */
  drills: number;
  failedLines: string[];
}

// ---------- 文本匹配（无需 LLM 的粗判） ----------
const STOP = new Set(
  "the a an is are was were be been being of to in on at for with and or but not no do does did this that these those i you he she it we they me him her them my your his its our their as by from what when where who whom which how why".split(/\s+/),
);
/** 内容 token：拉丁词（≥2）+ 中文 2-gram（单字串保留自身） */
export function contentTokens(s: string): string[] {
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const out: string[] = [];
  for (const tok of norm.split(" ")) {
    if (!tok) continue;
    if (/[\u4e00-\u9fff]/.test(tok)) {
      if (tok.length === 1) out.push(tok);
      else for (let i = 0; i + 2 <= tok.length; i++) out.push(tok.slice(i, i + 2));
    } else if (tok.length > 1 && !STOP.has(tok)) {
      out.push(tok);
    }
  }
  return out;
}
/** 文本 a 是否被 b 覆盖：a 的内容 token ≥ ratio 出现在 b 中 */
export function coveredBy(a: string, bTokens: Set<string>, ratio = 0.6): boolean {
  const w = [...new Set(contentTokens(a))];
  if (w.length === 0) return false;
  return w.filter((x) => bTokens.has(x)).length / w.length >= ratio;
}

/** 新叶子末尾附加对话日期（已含则不重复）——机械保证时间锚点，不依赖模型自觉 */
function withDate(text: string, date?: string): string {
  if (!date || text.includes(date) || /←\s*\d{4}-\d{2}-\d{2}/.test(text)) return text;
  return `${text} ← ${date}`;
}

/** 全树节点路径清单（供 ADD 同标题重定向） */
function nodePaths(mf: MemoryFile): string[] {
  const out: string[] = [];
  const walk = (n: any, path: string) => {
    for (const c of n.children) {
      const p = path ? `${path}/${c.title}` : c.title;
      out.push(p);
      walk(c, p);
    }
  };
  walk(mf.root, "");
  return out;
}

/** ADD 路径规范化：末段标题在树中已有唯一同标题节点 → 重定向（防重复主题节点分裂，下钻才看得见旧值） */
function canonicalAddPath(mf: MemoryFile, path: string): string {
  const title = path.split("/").pop()!.trim().toLowerCase();
  if (!title) return path;
  const same = nodePaths(mf).filter((p) => p.split("/").pop()!.trim().toLowerCase() === title);
  return same.length === 1 && same[0] !== path ? same[0]! : path;
}

function allLeaves(mf: MemoryFile): string[] {
  const out: string[] = [];
  const walk = (n: { leaves: string[]; children: any[] }) => {
    out.push(...n.leaves);
    for (const c of n.children) walk(c);
  };
  walk(mf.root as any);
  return out;
}

/** 归一化：小写 + 去非字母数字（供宽松匹配） */
const normText = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "");

/** 全树叶子定位（文本 → 完整路径），供 UPDATE 兑底 */
function leafLocations(mf: MemoryFile): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (n: any, path: string) => {
    for (const l of n.leaves) out.push({ path, text: l });
    for (const c of n.children) walk(c, path ? `${path}/${c.title}` : c.title);
  };
  walk(mf.root as any, "");
  return out;
}

/** 按叶子边界截断拼接的 section（避免把叶子切半导致模型引用非逐字旧值） */
function capAtLeafBoundary(joined: string, max: number): string {
  if (joined.length <= max) return joined;
  const head = joined.slice(0, max);
  const marks = [...head.matchAll(/\n\s*-\s/g)];
  const last = marks[marks.length - 1];
  return last?.index ? head.slice(0, last.index) : head;
}

// ---------- 写入（机械 / LLM 抽取 / LLM 更新感知） ----------
type IngestMode = "mechanical" | "llm" | "llm-update" | "turn-agent";

/** 当前记忆展平成 `[路径] 叶子` 行（供更新感知的写入提示） */
function memoryLines(mf: MemoryFile): string {
  const out: string[] = [];
  const walk = (n: any, path: string) => {
    for (const l of n.leaves) out.push(`[${path}] ${l}`);
    for (const c of n.children) walk(c, path ? `${path}/${c.title}` : c.title);
  };
  walk(mf.root, "");
  return out.join("\n");
}

/** 从模型输出里宽松提取 `- ` 事实行 */
function parseFacts(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+/.test(l))
    .map((l) => l.replace(/^[-*+]\s+/, "").replace(/[*_`]/g, "").trim())
    .filter(Boolean);
}

/** 应用模型给出的 ADD / UPDATE 操作（容错：单条失败不中断整个评测） */
async function applyOps(
  mf: MemoryFile,
  raw: string,
  failedOut?: string[],
  date?: string,
): Promise<{ adds: number; updates: number; failed: number }> {
  let adds = 0, updates = 0, failed = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    const u = /^UPDATE\b/i.test(t) ? t.replace(/^UPDATE\s*/i, "").split("|").map((x) => x.trim()) : null;
    const a = !u && /^ADD\b/i.test(t) ? t.replace(/^ADD\s*/i, "").split("|").map((x) => x.trim()) : null;
    try {
      if (u && u.length >= 3 && u[0] && u[1] && u[2]) {
        const nw = withDate(u.slice(2).join(" | "), date);
        let r = await mf.updateNode(u[0], u[1], nw);
        if (!r.changed) {
          // 兑底 1：旧值全树唯一逐字命中（裸名/错节点路径被纠正）
          const locs = leafLocations(mf);
          const exact = locs.filter((l) => l.text === u[1]);
          if (exact.length === 1) r = await mf.updateNode(exact[0]!.path, u[1], nw);
          else {
            // 兑底 2：旧值前缀（前 12 词）唯一子串命中（模型轻微改写/截断的引用）
            const pref = u[1]!.split(/\s+/).slice(0, 12).join(" ");
            if (pref.length >= 12) {
              const sub = locs.filter((l) => l.text.includes(pref));
              if (sub.length === 1) r = await mf.updateNode(sub[0]!.path, sub[0]!.text, nw);
              else {
                // 兑底 3：归一化前缀唯一命中（模型合并/改写多条叶子后的引用）
                const npref = normText(u[1]!).slice(0, 48);
                if (npref.length >= 24) {
                  const nsub = locs.filter((l) => normText(l.text).includes(npref));
                  if (nsub.length === 1) r = await mf.updateNode(nsub[0]!.path, nsub[0]!.text, nw);
                }
              }
            }
          }
        }
        if (r.changed) updates++;
        else {
          failed++;
          failedOut?.push(t);
        }
      } else if (a && a.length >= 2 && a[0] && a[1]) {
        await mf.upsertNode(canonicalAddPath(mf, a[0]), withDate(a.slice(1).join(" | "), date));
        adds++;
      } else if (t && !/^NOOP$/i.test(t) && !/^SEARCH\s/i.test(t)) {
        failed++;
        failedOut?.push(t);
      }
    } catch {
      failed++;
      failedOut?.push(t);
    }
  }
  return { adds, updates, failed };
}

async function ingest(mf: MemoryFile, s: Scenario, llm: LlmClient | null, mode: IngestMode): Promise<{ writeStats?: WriteStats } | void> {
  if (mode === "llm-update" && llm) {
    for (let i = 0; i < s.observations.length; i++) {
      const o = s.observations[i]!;
      // 第一遍：纯抽取（不带记忆上下文，保证抽取完整性）
      const facts = parseFacts(await llm.chat(EXTRACT_SYSTEM, extractUser(o.date, o.text), 8000));
      if (facts.length === 0) continue;
      // 第二遍：定向 supersede（当前记忆 + 新事实 → ADD/UPDATE）
      await applyOps(mf, await llm.chat(SUPERSEDE_SYSTEM, supersedeUser(memoryLines(mf), facts), 8000), undefined, o.date);
      // 回填：pass2 可能漏掉某些事实——确保每条抽出的事实都进了记忆（保召回）
      const leafTokens = new Set(allLeaves(mf).flatMap((l) => contentTokens(l)));
      for (const f of facts) if (!coveredBy(f, leafTokens)) await mf.upsertNode(`记忆/${o.id ?? `obs-${i + 1}`}`, f);
    }
    return;
  }
  // ---------- Turn 级 agent 仿真：每轮注入目录+召回，模型自主 ADD/UPDATE/NOOP ----------
  if (mode === "turn-agent" && llm) {
    const TOC_MAX = 1600;
    const RECALL_MAX = 2400;
    let recent: string[] = [];
    let lastSession: string | null = null;
    const stats = { adds: 0, updates: 0, failed: 0, searches: 0, drills: 0, failedLines: [] as string[] };
    let seenTurns = new Set<string>();
    for (let i = 0; i < s.observations.length; i++) {
      const o = s.observations[i]!;
      const sess = o.id?.split("-t")[0] ?? `obs-${i}`;
      if (sess !== lastSession) {
        recent = [];
        lastSession = sess;
        seenTurns = new Set();
      }
      // 提速：session 内逐字重复的 turn 直接跳过（合成数据 ~17% 重复，重复发言不新增信息）
      if (seenTurns.has(o.text)) {
        stats.skipped = (stats.skipped ?? 0) + 1;
        continue;
      }
      seenTurns.add(o.text);
      const toc = tocDigest(mf.root, { maxChars: TOC_MAX });
      const recentCtx = recent.slice(-2).join("\n");
      const provided = new Set<string>();
      let recall = "";
      try {
        const recallHits = mf.search(o.text, 4);
        for (const h of recallHits) provided.add(h.path);
        recall = capAtLeafBoundary(
          recallHits
            .map((h) => mf.renderSection(h.path) ?? "")
            .filter(Boolean)
            .join("\n---\n"),
          RECALL_MAX,
        );
      } catch {
        // 空树/检索失败视为无召回
      }
      let raw = await llm.chat(AGENT_WRITE_SYSTEM, agentWriteUser(toc, recall, recentCtx, o.date, o.text), 2000);
      // 阶段 1：模型主动 SEARCH → 给检索结果
      const sm = raw.match(/^SEARCH\s+(.+)$/im);
      if (sm?.[1]?.trim()) {
        stats.searches++;
        let found = "";
        try {
          for (const h of mf.search(sm[1].trim(), 4)) {
            provided.add(h.path);
            found += (found ? "\n---\n" : "") + (mf.renderSection(h.path) ?? "");
          }
          found = capAtLeafBoundary(found, RECALL_MAX);
        } catch {
          // 检索失败当作无结果
        }
        raw = await llm.chat(AGENT_WRITE_SYSTEM, agentWriteUser(toc, recall, recentCtx, o.date, o.text, found || "（无命中）"), 2000);
      }
      // 阶段 2：自动下钻——写入目标路径已存在但内容未在上下文 → 附上节点现状再确认（等价生产中写前 memory_read）
      const targetPaths = [...raw.matchAll(/^(?:ADD|UPDATE)\s+([^|\n]+?)(?:\s*\||$)/gim)]
        .map((m) => m[1]!.trim())
        .filter((p) => p && !provided.has(p) && mf.renderSection(p) !== null);
      if (targetPaths.length > 0) {
        stats.drills++;
        const nodeCtx = capAtLeafBoundary(
          [...new Set(targetPaths)]
            .slice(0, 3)
            .map((p) => mf.renderSection(p) ?? "")
            .filter(Boolean)
            .join("\n---\n"),
          RECALL_MAX,
        );
        raw = await llm.chat(
          AGENT_WRITE_SYSTEM,
          agentWriteUser(toc, recall, recentCtx, o.date, o.text, undefined, nodeCtx),
          2000,
        );
      }
      const r = await applyOps(mf, raw, stats.failedLines, o.date);
      stats.adds += r.adds;
      stats.updates += r.updates;
      stats.failed += r.failed;
      recent.push(o.text);
      if ((i + 1) % 50 === 0)
        console.log(
          `  … turn-agent 进度 ${i + 1}/${s.observations.length}（ADD ${stats.adds} · UPDATE ${stats.updates} · 失败 ${stats.failed}）`,
        );
    }
    stats.failedLines = stats.failedLines.slice(0, 20);
    return { writeStats: stats };
  }
  if (mode === "llm" && llm) {
    for (let i = 0; i < s.observations.length; i++) {
      const o = s.observations[i]!;
      const facts = parseFacts(await llm.chat(EXTRACT_SYSTEM, extractUser(o.date, o.text), 8000));
      const path = `记忆/${o.id ?? `obs-${i + 1}`}`;
      if (facts.length > 0) for (const f of facts) await mf.upsertNode(path, f);
      else if (o.text.trim()) await mf.upsertNode(`原文/${o.id ?? `obs-${i + 1}`}`, o.text.trim());
    }
    return;
  }
  // 机械：原文逐条
  for (let i = 0; i < s.observations.length; i++) {
    const o = s.observations[i]!;
    await mf.upsertNode(`原文/${o.id ?? `obs-${i + 1}`}`, o.text.trim());
  }
}

// ---------- 评分 ----------

/** 版本时间线：该路径（或包含该关键词的路径）的叶子级变更史（旧 → 新，按写入序） */
export function historyTimeline(mf: MemoryFile, pathQuery: string, maxChars = 3000): string {
  const q = pathQuery.trim().toLowerCase();
  if (!q) return "";
  const rows = mf
    .listChanges({ limit: 2000 })
    .filter(
      (c) =>
        (c.fromText || c.toText) &&
        (c.path.toLowerCase() === q || c.path.toLowerCase().endsWith("/" + q) || c.path.toLowerCase().includes(q)),
    )
    .sort((a, b) => a.revisionId - b.revisionId);
  const lines = rows.map(
    (c) =>
      `[#${c.revisionId}] ${c.path}:\n  [OLD·已被替换] ${c.fromText ?? "（新增）"}\n  [NEW·当时新值] ${c.toText ?? "（删除）"}`,
  );
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…（截断）`;
  return out;
}

/** 两阶段问答：模型可请求 HISTORY 获得版本时间线后再作答（EVAL_HISTORY=1 启用；默认关——无对话日期锚点时版本史会误导 as-of 题） */
export async function answerProbe(
  mf: MemoryFile,
  llm: LlmClient,
  question: string,
  ctx: string,
): Promise<{ pred: string; historyUsed: boolean; historyPath?: string }> {
  const historyEnabled = process.env.EVAL_HISTORY === "1";
  const system = historyEnabled ? `${ANSWER_SYSTEM}\n${HISTORY_RULE}` : ANSWER_SYSTEM;
  let pred = (await llm.chat(system, answerUser(ctx, question))).trim();
  const hm = pred.match(/^HISTORY\s+(.+)$/im);
  if (historyEnabled && hm?.[1]?.trim()) {
    const path = hm[1].trim();
    const hist = historyTimeline(mf, path);
    pred = (await llm.chat(system, answerUser(ctx, question, hist || "（该路径无变更记录）"))).trim();
    return { pred, historyUsed: true, historyPath: path };
  }
  return { pred, historyUsed: false };
}
export interface Result {
  id: string;
  competency: string;
  /** 抽取：recall（期望记住命中率）/ precision（1-噪音污染率） */
  recall?: number;
  precision?: number;
  /** 问答：正确数 / 总数 */
  qaPass?: number;
  qaTotal?: number;
  /** 问答分类桶：tag → { pass, total } */
  byTag?: Record<string, { pass: number; total: number }>;
  /** 写入操作统计（turn-agent） */
  writeStats?: WriteStats;
  /** 问答阶段触发 HISTORY 协议的题数 */
  historyProbes?: number;
  /** 判分模型用量（分流时） */
  judgeUsage?: Usage;
  details: string[];
}

export async function runScenario(s: Scenario, opts: { dir: string; llm: LlmClient | null; mode: IngestMode }): Promise<Result> {
  await mkdir(opts.dir, { recursive: true });
  const mf = await MemoryFile.open(opts.dir);
  const ingestInfo = await ingest(mf, s, opts.llm, opts.mode);

  const leaves = allLeaves(mf);
  const leafWords = new Set(leaves.flatMap((l) => contentTokens(l)));
  const details: string[] = [];
  const res: Result = { id: s.id, competency: s.competency, details };
  if (ingestInfo?.writeStats) res.writeStats = ingestInfo.writeStats;

  const remember = s.expectRemember ?? [];
  if (remember.length > 0) {
    const hit = remember.filter((x) => coveredBy(x, leafWords));
    res.recall = hit.length / remember.length;
    for (const x of remember) if (!hit.includes(x)) details.push(`✗ 漏记：${x}`);
  }
  const ignore = s.expectIgnore ?? [];
  if (ignore.length > 0) {
    const bad = ignore.filter((x) => coveredBy(x, leafWords));
    res.precision = 1 - bad.length / ignore.length;
    for (const x of bad) details.push(`✗ 记了噪音：${x}`);
  }

  const probes = s.probes ?? [];
  if (probes.length > 0 && opts.llm) {
    // M1 判分分流：答题用 opts.llm（快），判分用强模型（EVAL_JUDGE_MODEL，默认 glm-5.3 开 thinking；off=不分流）
    const judgeLlm =
      process.env.EVAL_JUDGE_MODEL === "off"
        ? opts.llm
        : LlmClient.fromEnv(process.env.EVAL_JUDGE_MODEL ?? "glm-5.3", { thinking: "auto" });
    let pass = 0;
    let historyUsed = 0;
    const byTag: Record<string, { pass: number; total: number }> = {};
    for (const p of probes) {
      const hits = mf.search(p.question, 5);
      const ctx = hits.map((h) => mf.renderSection(h.path) ?? "").join("\n\n---\n\n");
      const { pred, historyUsed: usedHistory } = await answerProbe(mf, opts.llm, p.question, ctx);
      if (usedHistory) historyUsed++;
      const system = p.kind === "refuse" ? REFUSE_SYSTEM : JUDGE_SYSTEM;
      const user = p.kind === "refuse" ? refuseUser(p.question, pred) : judgeUser(p.question, String(p.answer), pred);
      const verdict = (await judgeLlm.chat(system, user, 800)).trim().toUpperCase();
      const ok = verdict.startsWith("CORRECT");
      if (ok) pass++;
      else details.push(`✗ 问答：${p.question} → 「${pred}」（期望「${p.answer ?? "拒绝"}」）`);
      if (p.tag) {
        const b = (byTag[p.tag] ??= { pass: 0, total: 0 });
        b.total++;
        if (ok) b.pass++;
      }
    }
    res.qaPass = pass;
    res.qaTotal = probes.length;
    res.historyProbes = historyUsed;
    if (judgeLlm !== opts.llm) res.judgeUsage = judgeLlm.usage;
    if (Object.keys(byTag).length > 0) res.byTag = byTag;
  }
  return res;
}
