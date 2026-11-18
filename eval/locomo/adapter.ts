/**
 * LoCoMo → memory-x 适配层（纯逻辑 + 数据集定位）
 * =============================================
 * 只做两件事：① 找到数据集（复用而非拷贝进仓库）；② 把一段对话转成 memory-x 树大纲。
 * 不含任何 LLM/网络调用，便于单测与复用。
 *
 * 映射约定：
 *   一段对话 → 一个独立记忆仓（段内检索，避免串话）
 *   一个 session → 一个节点 `session-N`；首条叶子 `[date] …`；每轮 → 叶子 `[D<n>:<k>] speaker: text`
 *   evidence dia_id "D3:12" → 物化路径 "session-3"
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Turn {
  speaker: string;
  dia_id: string;
  text: string;
}
export interface QA {
  question: string;
  answer: string | number;
  evidence: string[];
  category: number;
}
export interface Conversation {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: QA[];
}

/** 上游数据集（Snap Research LoCoMo-10） */
export const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
/** 计分类别：1 multi-hop / 2 temporal / 3 open-domain / 4 single-hop（5 adversarial 不计分） */
export const EVAL_CATEGORIES = new Set([1, 2, 3, 4]);
export const CATEGORY_NAMES: Record<number, string> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

/** 用户级缓存路径（仓库外，避免把数据集拷贝进项目） */
export function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "memory-x", "locomo", "locomo10.json");
}

/**
 * 数据集定位（优先复用，绝不写入仓库）：
 *   1) 显式 --data 路径
 *   2) $LOCOMO_DATA（可指向 snap-research/locomo 克隆里的 data/locomo10.json）
 *   3) 用户级缓存（默认）
 * 都没有才下载到缓存目录。
 */
export async function resolveDataset(explicit?: string): Promise<{ path: string; data: Conversation[] }> {
  const candidates = [explicit, process.env.LOCOMO_DATA, cachePath()].filter(Boolean) as string[];
  let file = candidates.find((p) => existsSync(p));
  if (!file) {
    file = cachePath();
    await mkdir(dirname(file), { recursive: true });
    console.error(`[locomo] 下载数据集 → ${file}`);
    const res = await fetch(LOCOMO_URL);
    if (!res.ok) throw new Error(`数据集下载失败：${res.status}`);
    await writeFile(file, await res.text());
  }
  const data = JSON.parse(await readFile(file, "utf8")) as Conversation[];
  if (!Array.isArray(data) || data.length !== 10) throw new Error(`数据集异常：期望 10 段对话，实得 ${data?.length}`);
  return { path: file, data };
}

export function sessionCount(conv: Record<string, unknown>): number {
  return Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).length;
}

export interface SessionInfo {
  index: number;
  date?: string;
  turns: Turn[];
}

/** 逐 session 展开（供 LLM ingest 逐段整理） */
export function sessions(c: Conversation): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (let s = 1; s <= sessionCount(c.conversation); s++) {
    const date = c.conversation[`session_${s}_date_time`];
    out.push({
      index: s,
      date: typeof date === "string" ? date : undefined,
      turns: (c.conversation[`session_${s}`] as Turn[] | undefined) ?? [],
    });
  }
  return out;
}

export function speakers(c: Conversation): [string, string] {
  return [String(c.conversation.speaker_a ?? "A"), String(c.conversation.speaker_b ?? "B")];
}

/**
 * 把 LLM 输出规整成 parseFragment 能吃的大纲：
 * 剥代码块/强调，统一列表符号，把标题层级重映射为连续深度（避免「层级跳跃」报错）。
 */
export function sanitizeOutline(raw: string): string {
  const out: string[] = [];
  const stack: number[] = [];
  for (const rawLine of raw.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```")) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      const title = h[2]!.replace(/[*_`]/g, "").replace(/[/\[\]]/g, " ").replace(/\s+/g, " ").trim();
      if (!title) continue;
      const lvl = h[1]!.length;
      while (stack.length && stack[stack.length - 1]! >= lvl) stack.pop();
      stack.push(lvl);
      out.push(`${"#".repeat(Math.min(6, 2 + stack.length))} ${title}`);
      continue;
    }
    const b = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    const text = (b ? b[1]! : line).replace(/[*_`]/g, "").trim();
    if (text) out.push(`- ${text}`);
  }
  return out.join("\n");
}

/** 一段对话 → memory-x 大纲（供 MemoryFile.applyTree 一次成型） */
export function buildOutline(c: Conversation): string {
  const lines: string[] = [];
  for (let s = 1; s <= sessionCount(c.conversation); s++) {
    if (lines.length) lines.push("");
    lines.push(`## session-${s}`);
    const date = c.conversation[`session_${s}_date_time`];
    if (typeof date === "string") lines.push(`- [date] ${date}`);
    for (const t of (c.conversation[`session_${s}`] as Turn[] | undefined) ?? []) {
      lines.push(`- [${t.dia_id}] ${t.speaker}: ${t.text.replace(/\s*\n\s*/g, " ")}`);
    }
  }
  return lines.join("\n");
}

/** 该题的 gold 物化路径集合（evidence dia_id → session-N） */
export function goldSessions(q: QA): Set<string> {
  return new Set(q.evidence.map((e) => `session-${e.split(":")[0]!.replace(/^D/, "")}`));
}

/** 固定种子 RNG（抽样可复现） */
export function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Selection {
  byConv: Map<string, QA[]>;
  total: number;
  dist: Map<number, number>;
}

/**
 * 选题：
 *   sample>0 → 全局按类 1-4 真实比例分层随机抽 sample 题（保持基准分布）
 *   否则     → 每段取前 limit 题（limit=0 取全部）
 */
export function selectQuestions(convs: Conversation[], opts: { sample: number; limit: number; seed: number }): Selection {
  const byConv = new Map<string, QA[]>();
  const dist = new Map<number, number>();
  let total = 0;

  if (opts.sample <= 0) {
    for (const c of convs) {
      const qas = opts.limit > 0 ? c.qa.slice(0, opts.limit) : c.qa;
      byConv.set(c.sample_id, qas);
      total += qas.length;
      for (const q of qas) dist.set(q.category, (dist.get(q.category) ?? 0) + 1);
    }
    return { byConv, total, dist };
  }

  const pool = convs.flatMap((c) => c.qa.filter((q) => EVAL_CATEGORIES.has(q.category)).map((q) => ({ c, q })));
  const byCat = new Map<number, Array<{ c: Conversation; q: QA }>>();
  for (const p of pool) {
    if (!byCat.has(p.q.category)) byCat.set(p.q.category, []);
    byCat.get(p.q.category)!.push(p);
  }
  const rnd = mulberry32(opts.seed);
  const chosen = new Set<QA>();
  for (const arr of byCat.values()) {
    const want = Math.min(arr.length, Math.max(1, Math.round((opts.sample * arr.length) / pool.length)));
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    for (const p of copy.slice(0, want)) chosen.add(p.q);
  }
  for (const c of convs) {
    const qas = c.qa.filter((q) => chosen.has(q));
    if (qas.length === 0) continue;
    byConv.set(c.sample_id, qas);
    total += qas.length;
    for (const q of qas) dist.set(q.category, (dist.get(q.category) ?? 0) + 1);
  }
  return { byConv, total, dist };
}
