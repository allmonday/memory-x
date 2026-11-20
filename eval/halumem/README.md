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
npm run eval:halumem -- --mode turn-agent --sessions 5 # Turn 级 agent 仿真（每 turn 注入目录+召回，自主 ADD/UPDATE/NOOP）
npm run eval:halumem -- --qps 3                        # 每 session 最多 3 题（控成本）
```

参数：`--data` `--records N` `--sessions N` `--qps N` `--mode llm|mechanical|llm-update|turn-agent` `--model`。

三种写入模式构成消融对照：`llm`＝盲写（无记忆上下文，只 ADD）；`llm-update`＝批量两遍（抽取后再对着全树判 ADD/UPDATE）；`turn-agent`＝仿真真实运行时（逐 turn、目录+召回注入、主题路径、SEARCH+自动下钻、原地替换）——只有它测得到「每轮动态更新矫正」链路。

## turn-agent 迭代记录（2026-11-19，记录 1 前 5 sessions，glm-5.3）

| 版本 | precision | recall | UPDATE 次数 | 说明 |
|---|---|---|---|---|
| v1 盲写 | 0.000 | 0.935 | 0 | 模型从不 UPDATE |
| v2 +SEARCH/下钻 | 0.111 | 0.829 | 7 | 自动下钻把旧叶子递到上下文 |
| v3 +并列≠重复/纯状态句 | 0.222 | 0.772 | 7 | 宠物案干净替换，Cat/Parrot/Reptile 并列保留 |

**关键诊断**（对生产 extension 同样适用）：
1. 更正性发言只谈新值，FTS 按轮文本检索不到旧叶子 → 模型看不到要替换的对象，只能 ADD。修复＝写前下钻（SEARCH 或自动附节点现状）；
2. 旧 prompt 的「拿不准一律 ADD」保守偏置 + UPDATE 需逐字 match，使 supersede 几乎不触发；需改为「同属性新信号→必须 UPDATE，并存即错误」；
3. UPDATE 新句不要保留旧值字样（previously X），否则词面 precision 判残留；
4. 剩余短板：career 类隐式更新仍未替换（s4 转型没干掉 s1-3 的 considering…）；recall/precision 存在此消彼长，NOOP 偏严会吃掉真事实。

## 去拟合改写（2026-11-20，原则保留、基准字面量移除）

v3 提示词的规则多从记录 1 的失败案例补丁而来，枚举/例句带着基准原话。改写：

- 枚举改通用判据：「薪资/职衔/健康/雇佣」→「单值属性：判据是**两个取值能否同时成立**」；
- 例句去基准化：Martin / 15700→18000 / 宠物案句 → 中性人名与多领域例句（编辑器、摄影、徒步）；
- 「不要写 previously/used to」由机制推导（UPDATE 删除旧叶子、历史在版本记录，复述旧值＝复活已删内容），不再迁就词面判分器；
- 偏置口径统一：三套写入提示词统一为「同属性新取值 → 必须 UPDATE；拿不准是否同属性 → ADD（错换丢信息、并存可修正）」，消除 UPDATE_SYSTEM「拿不准一律 ADD」与 turn-agent「必须 UPDATE」的方向矛盾；
- 答题侧：否定证据规则改为方向对称的通用表述；「prefer the most recent」→「current vs former」（写入序≠对话日期，不能假设后写＝现值）。

⚠️ 0.72–0.75 的分数带是在调参所用的记录 1 上量得的。留出验证：
`npm run eval:halumem -- --start-record 2 --records 1 --mode turn-agent`（记录 2 从未参与调参）。

## 数据集（不落仓库）

许可 CC-BY-NC-ND-4.0（禁止再分发/演绎），因此从缓存或上游读取：
`--data <path>` → `$HALUMEM_DATA` → `~/.cache/memory-x/halumem/HaluMem-Medium.jsonl` → 从 HuggingFace 下载。

## 首跑（2026-11-18，记录 1 完整 65 个 session，164 题）

```
抽取 recall 1.000   precision 0.000
问答 97/164 = 0.591
  Memory Boundary              36/39  0.923   对抗/拒绝
  Basic Fact Recall            25/40  0.625   基本召回
  Memory Conflict              19/39  0.487   冲突消解
  Generalization & Application 11/31  0.355   泛化/应用（弱）
  Multi-hop Inference           5/9   0.556   多跳
  Dynamic Update                1/6   0.167   动态更新（最弱）
```
393 次调用 · 127 万 token · 20.5 分钟。

**读出来的信号**：
- **抽取 recall 高 / precision 0**：LLM 基本抽全了黄金点，但 `original_memories`（旧值）没被替换 → **supersede 缺口（M2）**；
- **Dynamic Update 0.167、Memory Conflict 0.487**：更新与冲突消解是当前最大短板，与示例场景结论一致；
- **Generalization & Application 0.355**：泛化/应用弱；
- **Memory Boundary 0.923**：对抗题（该拒绝）表现好，不乱编。

> ⚠️ 两个口径提醒：① 抽取判定是"内容 token 重叠"的粗判，recall 1.0 偏高；② 仅 1 条记录，只作方向参考。要统计意义需跑更多记录。
