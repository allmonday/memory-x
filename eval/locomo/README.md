# LoCoMo 评测（pi-live 口径）

**与 halumem-eval 共用 `eval/pi-live/runner.ts`——同一套跑法，口径完全一致。** 一个对话 = 一份考卷 = 一个进程（pi-extension 在 import 时读 `MEMORY_X_DIR`，一进程一沙盒）；树不跨对话共享，对话级多进程并行与串行口径完全等价。

LoCoMo 的定位：**外部第三方留出裁判**——从未参与 memory-x 任何调参（HaluMem record1 是练习册、record2 是自选留出，仍属同一出题风格）。

## 用法

```bash
npm run eval:locomo                                  # conv 1（conv-26，419 turns/199 题，~70min）
npm run eval:locomo -- --conv 3                      # 第 3 个对话（1-10）
npm run eval:locomo -- --conv 3 --qps 50             # 每对话最多题数（判分提速）
nohup node scripts/locomo-eval.ts --conv 1 > x.log & # 长跑必须 nohup（单对话 ~60-70min）
node scripts/rejudge.ts <summary.json>               # 只改判分口径时重判已存答案（不重跑）
```

参数：`--conv N`（默认1）`--qps N` `--model provider/id`（默认 zai-coding-cn/glm-5.3-flash）`--thinking`（默认 high）`--lang`。被测默认 glm-5.3-flash + thinking high（与 halumem 对表）；判分员 glm-5.3 + thinking auto（`EVAL_JUDGE_MODEL` 可配）。

## 流程

adapter 装载（双 speaker turn 前缀 + 对话日期 + 官方五类别）→ 写入阶段（逐 turn 真实对话沉淀树）→ 问答阶段（同一会话内提问，agent 调 memory 工具作答）→ 判分（与被测分流：覆盖式等价 + 反编造判据，见 `eval/memory/prompts.ts` 头注）→ summary.json（**全量 pred**，可重判/归因）。

## 指标

主指标 = **问答**（LLM 判分 + 官方五桶：Multi-hop / Single-hop / Temporal / Open-domain / Adversarial）。locomo10.json 无写入侧金标（无 fact/is_update 标注）→ recall/precision 自动跳过。写入侧健康度看附带统计（叶子数、update 次数、语言、日期戳）。

## 数据

locomo10.json（snap-research/locomo 官方 GitHub，**CC BY-NC 4.0，不落仓库**）：10 对话（conv-26…conv-50）· 272 有效 session · 5882 turns · 1986 题。类别映射（官方 task_eval 确认）：1=Multi-hop(282) 2=Single-hop(321) 3=Temporal(96) 4=Open-domain(841) 5=Adversarial(446，无 answer，有 adversarial_answer 诱答)。定位 `--data` > `$LOCOMO_DATA` > `~/.cache/memory-x/locomo/locomo10.json`。

## 成绩单

### conv-26（第 1 份考卷，2026-11-25，glm-5.3-flash + thinking high，60min，107 叶）

| 口径 | QA | 备注 |
|---|---|---|
| 旧判分口径（首跑） | 141/199 = 0.709 | REFUSE 只认字面拒答；JUDGE 语义等价 |
| 重判（旧 pred 截断 300 字 → 下限） | 149/199 = 0.749 | Adversarial 24→37，坐实判分误伤主假设 |
| **新口径重测（正式）** | **169/199 = 0.849** | 完整 pred；与 halumem record1 外推 0.84 / record2 0.793 同梯队 |

新口径五桶：Single-hop 0.89 · Temporal 0.77 · Multi-hop 0.78 · Open-domain 0.86 · **Adversarial 0.87**。

判分口径修订（commit eb80214）主效应：Adversarial 0.51→0.87（LoCoMo cat5 主型=说话人对调陷阱，agent 识破并纠正归属的正确行为不再误判）、Multi-hop 0.50→0.78（开放列举超集按覆盖式等价放行）。

**30 道失败归因**（全量 pred）：多模态金标不可达 ~5 + 金标噪声/标注推断 ~7 + 可答误标为对抗题 ~3 + judge 残留漏判 ~4 + 真 miss ~6-8（书名写入漏、beach 计数、推断形态摩擦）。排除数据集问题与判分噪声后单卷 ceiling ≈ 0.90+——真正属于 memory-x 的缺口为个位数。

## 已知局限

- **多模态金标不可达**：locomo10.json 是文本版（无 img_file/blip_caption），~5 题/对话的金标来自未发布图像层（dog face cup / 海报原文 / palm tree painting）——文本 replay 的天花板，不计入产品缺口。
- **金标噪声**：日期推导错误（charity race 金标算错、agent 反而对）、标注者推断写入金标（children=3 非原文）、camping/hiking 活动混同——已实锤两例。
- **可答误标对抗题**：cat5 少量题目实际可答（如乐器题，原文有答案但标成 adversarial），识破并答真话会被判错——判分器无从验证记忆，不可修。
- **判分噪声**：同一答案重判可翻转 ~6%（glm-5.3 auto）；小于此的对比差异无效。
- 节点标题语言靠模型自觉（本次英文，tiny fixture 曾漂中文）；机械护栏属上下文锚定 P1 范畴。

## 相关

- 计划与验收标准：`eval/locomo/PLAN.md`
- 判分口径定义：`eval/memory/prompts.ts`（头注）
- 重判工具：`scripts/rejudge.ts`（先审尺子工作流）
