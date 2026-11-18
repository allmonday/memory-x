# LoCoMo 评估组件

用 [LoCoMo](https://github.com/snap-research/locomo)（Snap Research, ACL 2024）长期对话记忆基准，
评测 memory-x 的**检索**与**端到端问答**能力。这是本项目的评估组件，不改动核心、不碰你的真实记忆。

## 它测什么

| 模式 | 说明 | 成本 |
|---|---|---|
| **检索（默认）** | 每题 `search(question, topK)`，看命中的节点是否覆盖 gold 所在的 session。指标 hit@1/3/k、MRR | 零 LLM 调用，秒级 |
| **端到端（`--answer`）** | 命中节点正文作上下文 → LLM 回答 → LLM 二元判分（业界 J-score，仅类 1-4） | 每题 2 次 LLM 调用 |

LoCoMo-10：10 段多会话对话，共 1986 题；类别 `1 multi-hop / 2 temporal / 3 open-domain / 4 single-hop / 5 adversarial`（5 类不计分）。

## 适配方式

```
一段对话   → 一个独立记忆仓（段内检索，避免 10 段串话）
一个 session → 节点 `session-N`；首条叶子 `[date] …`；每轮对话 → 叶子 `[D<n>:<k>] speaker: text`
一道题     → search → 命中 session 节点 → renderSection() 作为上下文
```
`evidence` 里的 `dia_id`（如 `D3:12`）用于判断是否命中 `session-3`。映射与数据集定位是纯逻辑，见 `adapter.ts`。

## 用法

```bash
npm run eval:locomo                                    # 全量检索（1986 题，~30s，零 LLM）
npm run eval:locomo -- --sample 200 --answer           # 分层抽 ~200 题做端到端
npm run eval:locomo -- --conv conv-26 --limit 20       # 单段前 20 题（仅检索）
npm run eval:locomo -- --sample 200 --answer --topK 5  # 指定 topK
```

参数：`--data <path>` `--conv <id>` `--limit N` `--sample N` `--seed N` `--topK N` `--answer` `--model <name>`。

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

## 提醒

LoCoMo 本身可复现性有争议（体量小、judge 不稳，已有 *LoCoMo Refined*），跨系统比数字需谨慎；
它更适合作为**本系统内迭代**的相对指标。
