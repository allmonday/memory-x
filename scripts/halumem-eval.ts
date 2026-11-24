/**
 * HaluMem 评测入口（标准：pi-live）
 * ==================================
 * 通过 pi SDK 起真实无头会话——生产 pi-extension + 生产系统提示词 + harness
 * 真实行为（上下文组装、compaction）——逐 user turn 对话，记忆经 MEMORY_X_DIR
 * 指向沙盒；probe 题在同一会话内提问；判分与被测模型分流（强模型判分）。
 * 核心循环在 eval/pi-live/runner.ts（与 LoCoMo 入口共用，防口径漂移）。
 *
 * 用法：
 *   npm run eval:halumem                                        # 记录1 第1场（快速验证）
 *   npm run eval:halumem -- --sessions 8                        # 冒烟（~40min）
 *   npm run eval:halumem -- --sessions 65                       # 记录1 全量（~7h，nohup）
 *   npm run eval:halumem -- --record 2 --sessions 77            # 留出验证（记录2 从未参与调参）
 *   npm run eval:halumem -- --thinking low                      # 调 thinking 档位
 *
 * 指标：问答（主指标，judge 强模型判分 + byTag 分桶）、recall（词面粗判）、
 * precision（叶级修正：更新对存在真过期叶子才计残留，见 eval/memory/metrics.ts）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runPiLive } from "../eval/pi-live/runner.ts";
import { loadRecord, type HaluMemRecord } from "../eval/halumem/adapter.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const RECORD = Number(arg("record") ?? "1");
const SESSIONS = Number(arg("sessions") ?? "1");
const MODEL = arg("model") ?? "zai-coding-cn/glm-5.3-flash";
const THINKING = (arg("thinking") ?? "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const QPS = Number(arg("qps") ?? "0");
const LANG = arg("lang"); // 语言声明（实验用：如 "en" 修 thinking low 下语言漂移；默认不注入，保持正式口径）

// ---------- 沙盒 ----------
const RUN_DIR = resolve("eval/halumem/runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-pi`);
const SANDBOX = join(RUN_DIR, `rec-${RECORD}`);
await mkdir(SANDBOX, { recursive: true });

// ---------- 数据：记录 N 前 S 场 ----------
const CACHE = join(homedir(), ".cache", "memory-x", "halumem", "HaluMem-Medium.jsonl");
const rec = JSON.parse(
  (await readFile(CACHE, "utf8")).split("\n").filter((l) => l.trim())[RECORD - 1]!,
) as HaluMemRecord;
const record = loadRecord(rec, { sessions: SESSIONS, qps: QPS || undefined });
console.log(
  `pi-live：记录${RECORD} 前${SESSIONS}场 · ${record.turns.length} user turns · 黄金点 ${record.expectRemember.length} · 更新对 ${record.expectReplace.length} · 题 ${record.probes.length} · 模型 ${MODEL} · thinking ${THINKING}\n沙盒：${SANDBOX}\n`,
);

// ---------- 跑 ----------
await runPiLive(record, {
  sandbox: SANDBOX,
  runDir: RUN_DIR,
  model: MODEL,
  thinking: THINKING,
  lang: LANG,
  meta: { dataset: "halumem", record: RECORD, sessions: SESSIONS },
});
