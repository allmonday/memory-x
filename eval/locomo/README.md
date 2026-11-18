# LoCoMo 评估组件

用 [LoCoMo](https://github.com/snap-research/locomo)（Snap Research, ACL 2024）长期对话记忆基准，
评测 memory-x 的**证据检索**与**端到端问答**能力。这是本项目的评估组件，不改动核心、不碰你的真实记忆。

## 记忆树形状（每段对话一个独立仓）

```
root
├─ 原文            ← 一个原文分支；其下 `session-N`，每轮一条原话叶子
└─ 结构化          ← 一个结构化分支（--llm-ingest）；其下 `session-N/topic`，LLM 抽取的事实
```

## 两种评测

| 模式 | 说明 | 成本 |
|---|---|---|
| **证据检索（默认）** | 每题 `search(question, topK)`，看拼出的上下文是否**覆盖证据句**（口径 B）。指标 cover@1/3/k、MRR | `--llm-ingest` 时每 session 1 次 LLM；否则零 LLM |
| **端到端（`--answer`）** | 命中节点正文作上下文 → LLM 回答 → LLM 二元判分（J-score，仅类 1-4） | 每题 2 次 LLM 调用 |

**命中口径 B（不看路径）**：把 `qa.evidence` 的 `dia_id` 取回原话，用**内容词重叠率 ≥ `--cover-min`（默认 0.7）**判定"上下文里有没有证据那句"。原文分支与结构化分支都能据此算分。

LoCoMo-10：10 段多会话对话，共 1986 题；类别 `1 multi-hop / 2 temporal / 3 open-domain / 4 single-hop / 5 adversarial`（5 类不计分）。

## 用法

```bash
npm run eval:locomo                                    # 原文分支，全量检索（1986 题，~30s，零 LLM）
node scripts/locomo.ts --llm-ingest --conv conv-26     # 加 LLM 结构化分支
npm run eval:locomo -- --sample 200 --answer           # 端到端（默认含结构化 + 问答）
node scripts/locomo.ts --sample 200 --answer --raw-ingest   # 端到端（不要结构化分支）
```

参数：`--data` `--conv` `--limit N` `--sample N` `--seed N` `--topK N` `--cover-min F` `--answer` `--llm-ingest` `--raw-ingest` `--ingest-max-tokens N` `--model`。

运行时 TTY 下原地刷新进度 `[i/N] xx.x% ●/◐/○`（答题模式 ✓/✗）；非 TTY 每 25 题一行。结尾打印覆盖率、J-score 与 LLM token 用量。

## 数据集：复用，不拷贝进仓库

按优先级定位，**都不会写进本仓库**：`--data <path>` → `$LOCOMO_DATA`（可指向 snap-research/locomo 克隆）→ `~/.cache/memory-x/locomo/locomo10.json` → 下载。

## 环境变量（仅需 LLM 时）

| 变量 | 默认 |
|---|---|
| `EVAL_BASE_URL` | `$PI_RUNTIME_GATEWAY_URL/v1`（OpenAI 兼容） |
| `EVAL_API_KEY` | `$LITELLM_API_KEY` |
| `EVAL_MODEL` | `deepseek-v4-1-flash` |

## 已知发现（conv-26，199 题，口径 B）

| 建树 | cover@1 | cover@3 | cover@5 | MRR |
|---|---|---|---|---|
| **仅原文分支** | **0.618** | 0.849 | **0.945** | **0.748** |
| 原文 + 结构化分支 | 0.261 | 0.643 | 0.749 | 0.457 |

**加入 LLM 结构化分支反而大幅拉低证据召回。** 因为结构化节点又短又关键词密集，bm25 长度归一化把它们顶到前列，把真正含证据原句的 `原文/session-N` 挤出 top-5。

> 早期（per-session 混合结构 + 路径口径）另有数据：机械 .678 / 纯结构化 .538 / 混合 .648（hit@1）。两套口径不可直接比较。

结论：**在纯词法检索 + 单索引下，LLM 结构化分支会与原文竞争并伤害召回。** 要让结构化发挥价值，需要：按分支分别检索再融合、给原文更高权重，或上语义/向量检索（M5）。

## 提醒

LoCoMo 可复现性有争议（体量小、judge 不稳，已有 *LoCoMo Refined*），跨系统比数字需谨慎；它更适合作为**本系统内迭代**的相对指标。
