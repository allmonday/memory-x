/**
 * LoCoMo 评测入口（标准：pi-live）
 * ================================
 * 与 halumem-eval 共用 eval/pi-live/runner.ts（口径完全一致）。
 * 一个对话 = 一次沙盒仿真 = 一个进程（pi-extension 在 import 时读 MEMORY_X_DIR，
 * 一进程一沙盒）；对话级多进程并行与串行口径完全等价（树不跨对话共享）。
 *
 * 用法：
 *   npm run eval:locomo                                    # 对话1（conv-26，419 turns/199 题）
 *   npm run eval:locomo -- --conv 3                        # 第 3 个对话（1-10）
 *   npm run eval:locomo -- --conv 3 --qps 50               # 每对话最多题数（判分提速）
 *   nohup npm run eval:locomo -- --conv 1 > locomo-1.log & # 长跑必须 nohup（单对话 ~6h）
 *
 * 数据：locomo10.json（CC BY-NC 4.0，不落仓库），定位 --data > $LOCOMO_DATA >
 * ~/.cache/memory-x/locomo/locomo10.json（官方 GitHub snap-research/locomo）。
 * 指标：问答（主指标，LLM 判分 + 官方五桶：Multi-hop/Single-hop/Temporal/
 * Open-domain/Adversarial）；写入侧无金标，recall/precision 跳过。
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runPiLive } from "../eval/pi-live/runner.ts";
import { loadConversation, loadLoCoMo, openingStatement } from "../eval/locomo/adapter.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CONV = Number(arg("conv") ?? "1"); // 1-10（数据集内序号，非 sample_id 后缀）
const QPS = Number(arg("qps") ?? "0");
const MODEL = arg("model") ?? "zai-coding-cn/glm-5.3-flash";
const THINKING = (arg("thinking") ?? "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const LANG = arg("lang"); // 语言声明（实验用；默认不注入，保持正式口径）

// ---------- 数据 ----------
const CACHE = join(homedir(), ".cache", "memory-x", "locomo", "locomo10.json");
const DATA = arg("data") ?? process.env.LOCOMO_DATA ?? CACHE;
const convs = await loadLoCoMo(DATA);
if (CONV < 1 || CONV > convs.length) throw new Error(`--conv 超范围：1-${convs.length}`);
const conv = convs[CONV - 1]!;
const record = loadConversation(conv, { qps: QPS || undefined });

// ---------- 沙盒 ----------
const RUN_DIR = resolve("eval/locomo/runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-pi`);
const SANDBOX = join(RUN_DIR, conv.sample_id);
await mkdir(SANDBOX, { recursive: true });

const bucket = Object.entries(
  record.probes.reduce<Record<string, number>>((acc, p) => ((acc[p.tag!] ??= 0), acc[p.tag!]++, acc), {}),
)
  .map(([k, v]) => `${k} ${v}`)
  .join(" · ");
console.log(
  `pi-live LoCoMo：${conv.sample_id}（第${CONV}/${convs.length}个对话）· ${record.sessionCount} 场 · ${record.turns.length} user turns · 题 ${record.probes.length} · ${bucket}\n` +
    `模型 ${MODEL} · thinking ${THINKING} · 判分员 ${process.env.EVAL_JUDGE_MODEL ?? "glm-5.3"}\n` +
    `沙盒：${SANDBOX}\n`,
);

// ---------- 跑 ----------
await runPiLive(record, {
  sandbox: SANDBOX,
  runDir: RUN_DIR,
  model: MODEL,
  thinking: THINKING,
  lang: LANG,
  opening: openingStatement(...record.speakers),
  meta: { dataset: "locomo", conv: conv.sample_id, convIndex: CONV, qps: QPS || undefined, data: DATA },
});
