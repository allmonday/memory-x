# HaluMem 评测（标准：pi-live）

**唯一评测入口。** 通过 pi SDK 起真实无头会话：生产 pi-extension、生产系统提示词、harness 真实行为（上下文组装、compaction）全部在被测范围内。逐 user turn 对话沉淀记忆，probe 题在同一会话内提问，判分与被测模型分流。

一个 record（一个 persona 的完整对话史）= 一次沙盒仿真，独立目录 `eval/halumem/runs/<ts>-pi/rec-N/`，不碰真实记忆。

## 用法

```bash
npm run eval:halumem                                  # 记录1 第1场（快速验证，~3min）
npm run eval:halumem -- --sessions 8                  # 冒烟（~40min）
npm run eval:halumem -- --sessions 65                 # 记录1 全量（~7h，nohup）
npm run eval:halumem -- --record 2 --sessions 77      # 留出验证：记录2 从未参与调参
```

参数：`--record N`（默认1）`--sessions N`（每记录前 N 场，默认1）`--model provider/id`（默认 zai-coding-cn/glm-5.3-flash）`--thinking off|minimal|low|medium|high`（默认 high）`--qps N`（每场最多题数，0=不限）。

被测 agent 默认 glm-5.3-flash + thinking high（pi Agent 场景关 thinking 影响工具调用质量）；判分员 glm-5.3 + thinking auto（`EVAL_JUDGE_MODEL` 可配）。

## 指标

| 指标 | 定义 | 口径说明 |
|---|---|---|
| **问答**（主指标） | probe 题在会话内作答，强模型语义判分，按 question_type 分 6 桶 | 与被测模型分流，判分不看对话过程 |
| recall | 黄金点内容词 ≥60% 出现在树上（词面粗判） | 措辞差异会漏，只作参考；元级金标（"has preferences in X"）天然难命中 |
| precision（叶级修正） | 更新对中「不存在真过期叶子」的比例；过期叶子 = 盖住旧值且对应新值盖不住的叶子 | **已弃用全树词面口径**（旧 token 出现即残留）——近义改写型数据上全量误报；pi-live 的现行叶子合理提及旧背景（"former role at X"）不算残留 |

## 数据

HaluMem-Medium.jsonl（CC-BY-NC-ND-4.0，不落仓库）：20 条 record（各 58~82 场 session，全集 3467 题），四层定位 `--data` > `$HALUMEM_DATA` > `~/.cache/memory-x/halumem/` > HuggingFace 下载。record → session（一场带日期的对话）→ turn；session 基本按日期升序，每轮带自己的 timestamp。

## 历史参考分数（口径已换，勿直接对比）

- turn-agent 仿真（已移除，git 历史可查）：记录1 全量 0.720–0.75 带宽（±8 题判分噪声），提示词在记录1 上调参过，偏乐观。
- pi-live 全量（记录1 65场，glm-5.3-flash + thinking high，324min）：**问答 0.701**（115/164），recall 0.984 史上最高，precision 叶级 0.861（25/180 过期，软更新模式）。49 道失败中 **33 道为「日期锚定拒答」**：机械日期戳=写入日 vs 题目 as-of 对话日期——replay 保真度问题，非生产 bug（真实使用写入日=对话日）。
- **日期修复（2026-11-21）**：评测脚本逐 turn 喂对话日期（turn 前缀 [YYYY-MM-DD] + MEMORY_X_DATE 指定机械戳的「今天」），叶子日期戳变为真实对话日期。
- **定向验证（前 15 场重跑，54min）**：同 40 题 **0.675 → 0.825**（净 +6：9 翻正 / 3 回归；顺序切片对齐口径——此前按题目文本匹配的计算会误伤后场同名题，已纠正）；Basic Recall 8/8、Multi-hop 4/4 全对。
- **组合成绩单（未真实重跑，两轮拼接：前15场=补跑树/后50场=原全量树）**：**问答 121/164 = 0.738**；recall 550/576 = **0.955**；precision 叶级 **0.856**（真过期 26/180）；叶子 628；工具 upsert 628/update 41/summary 55；总耗时 378.8min。保守下限——后半 124 题仍是未喂日期口径，其中 ~25 道日期拒答未修；**全量重跑外推 ≈ 0.84 ± 0.02**。
- 已修并验证：extension 语言一致性规则（recall 0.400→1.000）；叶子日期机械注入（MEMORY_X_DATE 可指定）。
- 已知缺口：偏好/关系类软更新并列失替（Labradors→Golden Retriever、Susan/Daniel 等，precision 主要失分点）；career 后期演变（2033 job title）。
- 遗留：HaluMem 近义改写型更新点占多数，词面 recall/precision 只作参考；compaction 全程未触发（1403 turns）；token 用量未记录（脚本缺口）。
