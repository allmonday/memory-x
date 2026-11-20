# HaluMem 评测（主测试集）

模拟真实使用闭环：**逐 turn 输入对话 → 记忆管家沉淀知识（ADD/UPDATE/SEARCH/下钻）→ 单轮问答探针 → 强模型判分**。
一个 record（一个 persona 的完整对话史）= 一次沙盒仿真，独立目录 `eval/halumem/runs/<ts>/rec-N/`，不碰真实记忆。

## 主路径（一条命令）

```bash
npm run eval:halumem                                        # 冒烟：turn-agent，第 1 条记录前 8 sessions
npm run eval:halumem -- --sessions 65                       # 记录 1 全量（65 sessions / 164 题）
npm run eval:halumem -- --start-record 2 --sessions 65      # 留出验证：记录 2 从未参与调参
```

全量长跑请 `nohup` 后台（参考：~81min / 560 万 tokens，flash + 关 thinking）。

## 流程

```
HaluMem-Medium.jsonl（四层定位：--data > $HALUMEM_DATA > ~/.cache/... > HF 下载）
  → adapter.toScenario：dialogue→observations（turn-agent 只喂 user turn）
                       memory_points→expectRemember / is_update+original_memories→expectIgnore
                       questions→probes（Memory Boundary→对抗题，question_type→tag）
  → harness.ingest（turn-agent）：每轮注入 TOC+FTS 召回+最近对话 → ADD/UPDATE/NOOP/SEARCH
                       SEARCH 两阶段 · 写前自动下钻 · UPDATE 四级兜底 · 日期机械注入
  → 评分：抽取 recall/precision（token 重叠粗判）+ 问答探针（检索→答题→强模型判分，byTag 6 桶）
  → runs/<ts>/summary.json（含 writeStats 与 failedLines 明细）
```

问答为**单轮探针**：每题独立检索、独立作答（已确认满足评估目标，不做多轮问答模拟）。

## 参数与配置

`--start-record N` `--records N` `--sessions N` `--qps N` `--mode <诊断模式>` `--model <模型>` `--data <path>`

模型（`eval/llm.ts`）：`EVAL_*` > `ZAI_CODING_CN_API_KEY`（z.ai，GLM）> `OPENAI_*` > pi 网关（兜底 flash）；
判分分流：答题用快模型，判分用 `EVAL_JUDGE_MODEL`（默认 glm-5.3 开 thinking）。

## 当前水平与历史结论

- 记录 1 全量（flash，turn-agent）：**0.720–0.75 带宽**（±8 题判分噪声），写入 ADD 358 / UPDATE 133 / 失败 12。
- 首跑盲写基线 0.591 → turn-agent 0.750；HISTORY 强开塌方 0.591 → 门控关闭恢复（无对话日期锚点时版本史误导 as-of 题）。
- 检索层四策略重放（FTS/RRF/union/全量）差异全在噪声内——**检索不是瓶颈**。
- 提示词已于 2026-11-20 去基准化（见 git log `refactor(eval): 写入/答题提示词去基准化`）：枚举改通用判据（单值属性=两取值能否同时成立）、例句去基准字面量、previously 禁令改由机制推导、三套写入提示词偏置统一、答题侧否定证据对称化。
- 迭代期四条关键诊断（对生产 extension 同样适用）：①更正性发言只谈新值→FTS 检索不到旧叶子，supersede 需写前下钻；②保守 ADD 偏置会让 UPDATE 几乎不触发；③旧 prompt 迭代表格见 git 历史；④单次全量排名不可迷信，以三轮中位数为准。
- ⚠️ 0.72–0.75 在调参所用的记录 1 上量得，留出集（记录 2+）验证待跑。

## 诊断工具（按需，不在主路径）

| 工具 | 用途 | 结论 |
|---|---|---|
| `--mode llm / mechanical / llm-update` | 写入消融对照（盲写 / 机械 / 批量 supersede） | 盲写 precision 0、机械噪音全记、supersede 已由 turn-agent 修复——消融已用完 |
| `scripts/qa-hybrid.ts <runDir>` | 同树同题四检索策略重放 | 检索不是瓶颈 |
| `scripts/memory-eval.ts` | 自建小场景（`eval/memory/`，含对抗题模板） | 框架 smoke test |
| `scripts/eval.ts` | 检索跑分（hit@1 / MRR，`eval/questions.json`） | 最早的检索层评测 |
| `EVAL_HISTORY=1` | HISTORY 版本史两阶段问答协议 | 默认关；需写入侧带对话日期才能启用 |

## 数据集（不落仓库）

许可 CC-BY-NC-ND-4.0（禁止再分发/演绎），从缓存或上游读取。
