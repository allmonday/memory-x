# 记忆评估框架（自建）

场景驱动的**操作级**记忆评估。参考：

- **HaluMem**：把评测拆到「抽取 / 更新 / 问答」三个阶段，看每阶段的对错（尤其"记忆幻觉"）。
- **MemoryAgentBench**：能力维度——准确检索、冲突消解、长程理解、测试时学习。

目标不是复刻它们的数据集，而是**用贴合 memory-x 真实用法的小场景**，量化它的核心行为：
**该不该记、记了会不会被更新、用的时候能不能调出来、会不会编。**

## 设计

```
场景(scenario) = 一段观察材料 + 期望
  │
  ├─ ingest 写入沙盒记忆（eval/memory/runs/<ts>/<id>/）
  │    ├─ llm        让模型抽取事实（贴近真实用法 / M2）
  │    └─ mechanical 原文逐条（对照基线）
  │
  └─ 评分
       ├─ extraction：期望记住的 recall / 期望忽略的 precision
       ├─ update    ：旧值是否被替换（precision 掉 → 暴露无 supersede）
       └─ probes    ：问答（LLM 判分）+ 对抗题应拒绝
```

沙盒是**独立目录**，绝不碰真实记忆；唯一共享的是核心代码和 LLM 配额。

## 场景格式

```jsonc
{
  "id": "update-1",
  "title": "偏好变更应替换旧值",
  "competency": "extraction | update | recall | answer",
  "ingest": "llm",                       // 或 "mechanical"
  "observations": [                      // 观察材料（按先后）
    { "id": "t1", "date": "2026-10-01", "text": "数据库还是用 SQLite 吧。" },
    { "id": "t2", "date": "2026-11-18", "text": "改成 Postgres 了。" }
  ],
  "expectRemember": ["Postgres"],        // 抽取应命中
  "expectIgnore": ["SQLite"],            // 不该残留（测 supersede）
  "probes": [
    { "question": "现在数据库用什么？", "answer": "Postgres" },
    { "question": "我最喜欢的电影？", "kind": "refuse" }   // 对抗题
  ]
}
```

## 用法

```bash
npm run eval:memory                          # 默认 LLM 抽取 + 问答
node scripts/memory-eval.ts --mode mechanical # 机械建树（对照基线，零 LLM 抽取）
node scripts/memory-eval.ts --file my.json --filter update-1
```

结果写 `eval/memory/runs/<时间戳>/`（gitignore）：每场景 `summary.json`（含逐条失败明细）+ 顶层 `summary.json`（含 token 用量）。

## 示例场景的当前得分（`scenarios.example.json`，4 场景）

| 场景 | 机械模式 | LLM 抽取 |
|---|---|---|
| extract-1 抽取 | recall 1.0 / **precision 0.0**（噪音全记） | recall 1.0 / **precision 1.0** |
| update-1 更新 | recall 1.0 / precision 0.0 | recall 1.0 / precision 0.0（**无 supersede，M2 缺口**） |
| recall-1 召回 | —（机械模式不跑问答） | 问答 1/2 |
| refuse-1 抗幻觉 | — | 问答 1/1 |

**已经从示例里读出的信号**：
1. **LLM 抽取明显优于机械**：precision 0 → 1（机械把寒暄噪音也当记忆记了）；
2. **更新（supersede）是当前最大缺口**：旧值 `SQLite` 仍在，precision 0——正是 M2 要解决的；
3. **抗幻觉 OK**：材料里没有的能拒绝；
4. 框架自身的**粒度问题**：抽取匹配是"内容 token 重叠 ≥ 0.6"的粗判，措辞差异会误判；judge 对等价日期偶有误判——按需换更稳的判定。

## 待补（可选）

- **测试时学习（TTL）**：`MemoryAgentBench` 里的能力——给反馈后能否学会并复用。
- **更强的抽取判定**：用 LLM 判"该记的记了吗 / 记的有没有幻觉"，替代 token 重叠。
- **冲突消解**：同一实体多来源冲突，看是否收敛到一致结论。
