# LoCoMo 评估组件

用 [LoCoMo](https://github.com/snap-research/locomo)（Snap Research, ACL 2024）长期对话记忆基准，
评测 memory-x 的**检索**与**端到端问答**能力。这是本项目的评估组件，不改动核心、不碰你的真实记忆。

## 它测什么

| 模式 | 说明 | 成本 |
|---|---|---|
| **检索（默认）** | 每题 `search(question, topK)`，看命中的节点是否覆盖 gold 所在的 session。指标 hit@1/3/k、MRR | 零 LLM 调用，秒级 |
| **端到端（`--answer`）** | 命中节点正文作上下文 → LLM 回答 → LLM 二元判分（业界 J-score，仅类 1-4） | 每题 2 次 LLM 调用 |

建树方式可选（见下）：**机械**（每轮原文一条叶子）或 **LLM ingest**（模型把对话整理成主题+事实）。

LoCoMo-10：10 段多会话对话，共 1986 题；类别 `1 multi-hop / 2 temporal / 3 open-domain / 4 single-hop / 5 adversarial`（5 类不计分）。

## 适配方式

```
一段对话   → 一个独立记忆仓（段内检索，避免 10 段串话）
一个 session → 节点 `session-N`；首条叶子 `[date] …`；每轮对话 → 叶子 `[D<n>:<k>] speaker: text`
一道题     → search → 命中 session 节点 → renderSection() 作为上下文
```
`evidence` 里的 `dia_id`（如 `D3:12`）用于判断是否命中 `session-3`。映射与数据集定位是纯逻辑，见 `adapter.ts`。

## 建树：机械 vs LLM ingest

memory-x 的真实设计里，入树本应由 LLM 整理（M2）。因此：

- **机械建树**（默认，零 LLM）：一段对话 → `session-N` 节点，每轮原文一条叶子。快、廉价，保留全部表层关键词。
- **LLM 建树**（`--llm-ingest`）：逐个 session 把对话丢给模型，整理成「描述性主题 + 事实」子树（仍挂在 `session-N` 下，保留 `session-N` 锚点与日期叶子）。`--answer` 时**默认开启**，用 `--raw-ingest` 退回机械。
- `--ingest-max-tokens N`（默认 8000）：推理模型（如 deepseek-v4-1-flash）的 reasoning 会吃掉输出预算，预算不足会导致 content 为空。

## 用法

```bash
npm run eval:locomo                                    # 全量检索：机械建树（1986 题，~30s，零 LLM）
node scripts/locomo.ts --llm-ingest --conv conv-26     # LLM 建树 + 检索
npm run eval:locomo -- --sample 200 --answer           # 端到端（默认 LLM 建树 + 回答 + 判分）
node scripts/locomo.ts --sample 200 --answer --raw-ingest   # 端到端（机械建树）
node scripts/locomo.ts --sample 200 --answer --topK 5  # 指定 topK
```

参数：`--data <path>` `--conv <id>` `--limit N` `--sample N` `--seed N` `--topK N` `--answer` `--llm-ingest` `--raw-ingest` `--ingest-max-tokens N` `--model <name>`。

运行时输出**实时进度**：TTY 下原地刷新 `[i/N] xx.x% ✓/✗ conv · 类别`（检索模式用 ○/◐/●）；重定向/非 TTY 时每 25 题打一行。结尾打印检索指标、各类 J-score 与 LLM token 用量。

## 数据集：复用，不拷贝进仓库

按优先级定位，**都不会写进本仓库**：

1. `--data <path>`
2. `$LOCOMO_DATA` —— 可指向你已有克隆：
   `export LOCOMO_DATA=~/locomo/data/locomo10.json`
3. 用户级缓存 `~/.cache/memory-x/locomo/locomo10.json`（`$XDG_CACHE_HOME` 可改）
4. 都没有才从上游 `snap-research/locomo` 下载到缓存

## 环境变量（仅 `--answer` 需要）

| 变量 | 默认 |
|---|---|
| `EVAL_BASE_URL` | `$PI_RUNTIME_GATEWAY_URL/v1`（OpenAI 兼容） |
| `EVAL_API_KEY` | `$LITELLM_API_KEY` |
| `EVAL_MODEL` | `deepseek-v4-1-flash` |

## 结果

写入 `eval/locomo/runs/<时间戳>/`（gitignore）：每段 `<sample_id>.json` + 汇总 `summary.json`
（含检索指标、各类 J-score、**LLM token 用量**、逐题明细）。

## 隔离说明

评估在自己的沙盒目录里用**真核心代码**重演对话历史，每个记忆仓是独立 SQLite 文件；
与 `~/memory-x/memory/`（pi 的真实记忆）没有任何交集。唯二共享：核心代码（只读引用）、LLM 网关配额。

## 已知发现（conv-26，199 题，仅检索）

| 建树方式 | hit@1 | hit@3 | hit@5 | MRR |
|---|---|---|---|---|
| 机械（每轮原文） | **0.678** | 0.824 | 0.910 | 0.768 |
| LLM 纯结构化（按人名分组） | 0.487 | — | — | — |
| LLM 纯结构化（禁人名标题） | 0.538 | 0.774 | 0.824 | 0.658 |
| LLM 混合（原文叶子 + `整理要点` 子树） | 0.648 | **0.829** | 0.894 | 0.747 |

结论：
- **纯结构化会在纯词法检索下掉分**：摘要丢掉表层关键词 + 主题节点互撞。
- **混合（原文保留 + 结构化子树）基本追平机械**（hit@1 0.648 vs 0.678），既不伤召回又拿到组织。
- 结构化在**词法检索**上不加分（原文已在），它的价值应在**答案质量（J-score）**与**语义检索（M5）**上体现——需做端到端 A/B 验证。

## 提醒

LoCoMo 本身可复现性有争议（体量小、judge 不稳，已有 *LoCoMo Refined*），跨系统比数字需谨慎；
它更适合作为**本系统内迭代**的相对指标。
