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

参数：`--data` `--conv` `--limit N` `--sample N` `--seed N` `--topK N` `--cover-min F` `--answer` `--llm-ingest` `--raw-ingest` `--fusion none|raw-first|raw-only|interleave` `--ingest-max-tokens N` `--model`。

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

| 建树 / 检索策略 | cover@1 | cover@3 | cover@5 | MRR |
|---|---|---|---|---|
| 仅原文分支（无结构化） | 0.618 | 0.849 | **0.945** | 0.748 |
| 双分支 · 混在一个池（`fusion=none`） | 0.261 | 0.643 | 0.749 | 0.457 |
| 双分支 · `raw-first` 融合（默认） | 0.638 | 0.854 | 0.925 | 0.751 |
| 双分支 · `raw-only` | 0.638 | **0.859** | 0.935 | **0.757** |
| 双分支 · `interleave` / 配额注入（r4+s1 等） | ≤0.638 | ~0.85 | ≤0.905 | ≤0.750 |

两点结论：
1. **不融合（一个池）会灾难性掉分**（cover@1 0.618→0.261）：结构化节点短且关键词密集，bm25 长度归一化把它们顶到原文前面，把含证据原句的 `原文/session-N` 挤出 top-5。
2. **分检融合能完全修复**（`raw-first` 拉回 0.638）。但**结构化对“证据覆盖”零增量**——任何让它进 top-5 的配额都会降低 cover@5。证据检索靠原文；结构化的价值只能在 **答案质量（J-score）** 或 **语义检索（M5）** 上体现。

### 端到端 J-score A/B（200 题分层抽样，seed=1）

| 建树 / 检索 | 总体 | cat1 多跳 | cat2 时间 | cat3 开放 | cat4 单跳 | token |
|---|---|---|---|---|---|---|
| 仅原文分支 | 0.630 | 0.270 | 0.667 | 0.333 | 0.771 | ~100 万 |
| 原文 + 结构化（raw-first） | **0.655** | 0.270 | 0.738 | 0.417 | 0.780 | ~155 万 |

结构化带来 **+2.5 分（+5/200 题）**，方向上是时间类/开放类提升；但在 n=200 下约 ±3.4 分（1σ），**接近噪声**，而 token 多花 55%。当前结论：词法检索 + 结构化在 J-score 上收益不明确，性价比低；要坐实需更大样本或语义检索。

## 提醒

LoCoMo 可复现性有争议（体量小、judge 不稳，已有 *LoCoMo Refined*），跨系统比数字需谨慎；它更适合作为**本系统内迭代**的相对指标。
