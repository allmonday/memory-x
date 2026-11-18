# HaluMem 适配（真实测试集）

把 [HaluMem](https://github.com/MemTensor/HaluMem)（IAAR-Shanghai, arXiv 2511.03506，**CC-BY-NC-ND-4.0**）
接进本项目自建的记忆评估框架。它是**操作级**记忆幻觉基准，结构天生对上我们的三阶段。

## 映射

| HaluMem | 本框架 |
|---|---|
| 每个 session 的 `dialogue` | 一条 observation（整段对话灌入记忆） |
| `memory_points`（is_update=False） | `expectRemember` —— 抽取 completeness |
| `memory_points.is_update=True` + `original_memories` | `expectIgnore` —— 旧值应被替换（supersede） |
| `questions[].question_type` | probe 的 `tag`，分桶统计 |

`question_type` → 判定：`Memory Boundary` = 对抗题（应拒绝），其余 = 正常问答。
类别：`Basic Fact Recall / Memory Conflict / Dynamic Update / Multi-hop Inference / Generalization & Application / Memory Boundary`。

## 用法

```bash
npm run eval:halumem                                   # Medium，第 1 条记录前 8 session
npm run eval:halumem -- --records 2 --sessions 10      # 前 2 条，各前 10 session
npm run eval:halumem -- --mode mechanical              # 机械建树对照
npm run eval:halumem -- --qps 3                        # 每 session 最多 3 题（控成本）
```

参数：`--data` `--records N` `--sessions N` `--qps N` `--mode llm|mechanical` `--model`。

## 数据集（不落仓库）

许可 CC-BY-NC-ND-4.0（禁止再分发/演绎），因此从缓存或上游读取：
`--data <path>` → `$HALUMEM_DATA` → `~/.cache/memory-x/halumem/HaluMem-Medium.jsonl` → 从 HuggingFace 下载。

## 首次跑（2026-11-18，记录 1 前 3 个 session，9 题）

```
抽取 recall 0.930   precision 0.000
问答 7/9   ← Memory Boundary 2/2 · Basic Fact Recall 3/3 · Memory Conflict 2/4
```

- **抽取 recall 高**：LLM 抽取基本覆盖了黄金记忆点；
- **precision 0**：`original_memories`（旧值）仍未被替换 → 印证 **supersede 缺口（M2）**；
- **Memory Conflict 最弱**：冲突消解是当前短板，与示例场景结论一致。

> 样本很小（3 session / 9 题），只作跑通与方向参考。放大 `--sessions/--records` 才有统计意义。
