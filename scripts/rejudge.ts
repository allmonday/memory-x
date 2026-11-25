/**
 * 重判脚本（先审尺子工作流）：用当前判分口径重判历史 summary.json 里已存的答案。
 * 不重跑对话/问答——判分与被测分流（M1），重判=对 (question, gold, pred) 的纯函数重放。
 *
 * 用法：
 *   node scripts/rejudge.ts eval/locomo/runs/<ts>-pi/summary.json            # 默认 3 并发
 *   node scripts/rejudge.ts <summary.json> --par 4
 *   EVAL_JUDGE_MODEL=glm-5.4 node scripts/rejudge.ts <summary.json>          # 换判分员
 *
 * 输出：新旧总分/byTag 对照、翻正与回退清单（stderr 台式日志）；结果落同目录 rejudged.json。
 * 注意：2026-11-25 前的 runner 把 pred 截到 300 字符（行尾标 truncated=true）——覆盖式
 * 判分下截断可能漏判（偏保守），重判结果是**下限**；权威数字以重跑为准（新 runner 存全量 pred）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LlmClient } from "../eval/llm.ts";
import { JUDGE_SYSTEM, REFUSE_SYSTEM, judgeUser, refuseUser } from "../eval/memory/prompts.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = process.argv[2];
if (!file) throw new Error("用法：node scripts/rejudge.ts <summary.json> [--par N]");
const PAR = Math.max(1, Number(arg("par") ?? "3"));

const summary = JSON.parse(await readFile(file, "utf8"));
const rows: Array<Record<string, any>> = summary.qaResults;
if (!Array.isArray(rows) || rows.length === 0) throw new Error(`qaResults 缺失：${file}`);

const judge = LlmClient.fromEnv(process.env.EVAL_JUDGE_MODEL ?? "glm-5.3", { thinking: "auto" });
const isRefuse = (r: Record<string, any>) => r.gold === "（拒绝）" || r.adversarialAnswer !== undefined;

// ---------- 并发池重判（网络失败沿用旧判，不引入假翻正） ----------
const out: Array<Record<string, any>> = new Array(rows.length);
let idx = 0;
let done = 0;
async function worker(): Promise<void> {
  for (;;) {
    const i = idx++;
    if (i >= rows.length) return;
    const r = rows[i]!;
    const pred = String(r.pred ?? "");
    const refuse = isRefuse(r);
    const system = refuse ? REFUSE_SYSTEM : JUDGE_SYSTEM;
    const user = refuse ? refuseUser(r.question, pred, r.adversarialAnswer) : judgeUser(r.question, r.gold, pred);
    let ok = false;
    let verdict = "";
    try {
      verdict = (await judge.chat(system, user, 800)).trim().toUpperCase();
      ok = verdict.startsWith("CORRECT");
    } catch (e) {
      ok = Boolean(r.ok); // 判分调用失败：沿用旧判
      verdict = `ERROR ${String(e).slice(0, 60)}`;
    }
    out[i] = { ...r, oldOk: Boolean(r.ok), ok, verdict, truncated: pred.length >= 300 };
    done++;
    if (done % 25 === 0) console.error(`  重判 ${done}/${rows.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(PAR, rows.length) }, () => worker()));

// ---------- 汇总 ----------
const tally = (get: (r: any) => boolean) => {
  let pass = 0;
  const byTag: Record<string, { pass: number; total: number }> = {};
  for (const r of out) {
    if (get(r)) pass++;
    const b = (byTag[r.tag] ??= { pass: 0, total: 0 });
    b.total++;
    if (get(r)) b.pass++;
  }
  return { pass, byTag };
};
const oldR = tally((r) => r.oldOk);
const newR = tally((r) => r.ok);
const fixedUp = out.filter((r) => !r.oldOk && r.ok);
const regressed = out.filter((r) => r.oldOk && !r.ok);
const truncated = out.filter((r) => r.truncated);

console.log(`\n════════ 重判（${file}）════════`);
console.log(`旧口径  ${oldR.pass}/${rows.length} = ${(oldR.pass / rows.length).toFixed(3)}`);
console.log(`新口径  ${newR.pass}/${rows.length} = ${(newR.pass / rows.length).toFixed(3)}  （翻正 ${fixedUp.length} · 回退 ${regressed.length} · 疑似截断 pred ${truncated.length}/${rows.length} → 结果偏保守）`);
for (const tag of new Set([...Object.keys(oldR.byTag), ...Object.keys(newR.byTag)]))
  console.log(`  ${(tag ?? "?").padEnd(16)} ${oldR.byTag[tag]?.pass ?? 0}/${oldR.byTag[tag]?.total ?? 0} → ${newR.byTag[tag]?.pass ?? 0}/${newR.byTag[tag]?.total ?? 0}`);
console.log(`判分用量：${judge.usageLine()}`);
if (regressed.length) {
  console.log(`\n── 回退（新口径更严，需人工复核）──`);
  for (const r of regressed) console.log(`  ✗→✓反 [${r.tag}] ${r.question}\n     ${String(r.pred).replace(/\n/g, " ").slice(0, 120)}`);
}
if (fixedUp.length) {
  console.log(`\n── 翻正（旧口径误伤）──`);
  for (const r of fixedUp) console.log(`  ✗→✓ [${r.tag}] ${r.question}`);
}

const outFile = join(dirname(file), "rejudged.json");
await writeFile(outFile, JSON.stringify(
  {
    source: file, rejudgedAt: new Date().toISOString(), judgeModel: judge.model,
    oldPass: oldR.pass, newPass: newR.pass, total: rows.length,
    oldByTag: oldR.byTag, newByTag: newR.byTag,
    fixedUp: fixedUp.map((r) => r.question), regressed: regressed.map((r) => r.question),
    truncatedCount: truncated.length, rows: out, judgeUsage: judge.usage,
  },
  null, 2,
));
console.log(`\n结果：${outFile}`);
