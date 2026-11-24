# LoCoMo 评测（pi-live 口径）— 实施计划

> 目标：在 pi-live 单一标准下新增 LoCoMo 验收——与 HaluMem（record1 练习册 / record2 留出）互补的**外部第三方数据集**，从未参与 memory-x 任何调参。
> 状态：P0-P2 已完成（2026-11-25）；决策已定：D-A 共享 runner、D-B QA 全量、D-C glm-5.3-flash + thinking high。P0 数据体检见文末事实清单。

## 为什么是 LoCoMo

- HaluMem record1 调过参、record2 是自选留出，仍属「同一出题风格」；LoCoMo 是 ACL 2024 的独立基准，题目风格、时间跨度、对话结构都不同——**外部留出的最终裁判**。
- 时间跨度硬（每对话 6~22 个月，最多 32 场 session），temporal 桶直接考版本史/日期锚定能力。
- adversarial 桶（446 题）直接考 REFUSE 行为——memory-x 的「宁缺毋滥」原则第一次有专门考卷。
- 全行业通用对照面（Mem0/MemGPT/Zep 都报过 LoCoMo 数字，口径不可直接比，但桶型可对照）。

## 数据事实（P0 已体检，2026-11-25）

- 来源：`snap-research/locomo` GitHub 官方库 `data/locomo10.json`（2.8MB），已下载到 `~/.cache/memory-x/locomo/locomo10.json`。许可 **CC BY-NC 4.0 → 不落仓库**（同 halumem 原则）。
- 规模：10 对话（conv-26…conv-50）· 272 sessions · **5882 turns** · **1986 题** · 对话文本约 18 万 tokens。
- 结构：`conversation = {speaker_a, speaker_b, session_N_date_time, session_N:[{speaker, dia_id, text}]}`；`qa = {question, answer, evidence:[dia_id], category}`；另有 `event_summary / observation / session_summary`（v1 不用）。
- **类别映射（官方 evaluation.py 确认）**：`1=multi-hop(282) 2=single-hop(321) 3=temporal(96) 4=open-domain(841) 5=adversarial(446)`；cat5 无 `answer`（444/446），有 `adversarial_answer`（诱答）。
- 日期格式 `"1:56 pm on 8 May, 2023"` 需解析为 ISO；无 img_file、无空 text（干净）。
- 官方判分：token 归一化+Porter 词干 F1/EM；cat1 拆 sub-answer 算 partial F1；cat5 检查输出含 "no information available"/"not mentioned"。我们用已有的 LLM judge（JUDGE_SYSTEM/REFUSE_SYSTEM）为自口径，词面 F1 可作次级对照——README 记录口径差异。

## 阶段计划

### P0 — 数据落地与体检 ✅（2026-11-25）

### P1 — adapter（eval/locomo/adapter.ts + 单测）✅
- `loadConversation(conv): LoComoCase`：turns（`{content: "Speaker: text", date: ISO}`）、probes（tag=官方类别名，cat5 → `refuse:true` + adversarialAnswer）、`expectRemember/expectReplace = []`（无写入侧金标，主指标=QA）；evidence 保留进 probes。
- 日期解析 `"1:56 pm on 8 May, 2023"` → ISO（全量 288/288 可解析，含 16 空 session 跳过）；`openingStatement(a, b)` 固定开场文案。
- 单测 6 项（eval/tests/locomo-adapter.test.ts）：日期解析/类别映射/装载形态/qps 限流/开场文案/schema 快照（10 对话/1986 题/类别分布/5882 turns）。全套 `npm test` 159 绿。

### P2 — 评测入口 ✅
- 抽共享 `eval/pi-live/runner.ts`（types.ts 公共类型上移；token usage 采集顺手补上：被测 message_end 累计 + judge usageLine）；halumem-eval.ts 改薄壳，1-session 回归 3/3、recall 0.933 与历史水位一致。
- `npm run eval:locomo`，沙盒 `eval/locomo/runs/<ts>-pi/<sample_id>/`（一进程一沙盒）；微型 fixture（7 turns/3 题）端到端 3/3：开场声明/日期前缀/拒答题判分/usage 计量/summary.json（含 evidence + adversarialAnswer）全部生效。
- 观察项（非门槛）：节点标题语言靠模型自觉（tiny 跑出中文标题+英文叶子；halumem 基线为英文标题；叶级指标不受影响）——机械护栏属上下文锚定 P1 范畴，不在本计划。

### P3 — 单对话冒烟验收（conv-1，419 turns/199 题，~5-6h nohup）｜当天挂后台
**验收标准（机制性）**：
- [ ] exit 0，summary.json 落盘；turn 数=419、题数=199、五桶分布与金标一致
- [ ] 叶子全英文（无语言漂移）；叶子日期戳=对话日期（抽查）
- [ ] 无巨节点异常（叶子数 100~400 量级合理）、无异常长叶占比超标
- [ ] QA ≥ 0.55（「链路未坏」底线；halumem 首场 0.85 的 LoCoMo 难度折算，正式水位看 P4）
- [ ] 记录 compaction 是否首次触发（观察点：halumem 1403 turns 未触发）

### P4 — 全量 10 对话（2 进程并行，~25-30h 墙钟，跨 1-2 天 nohup）
- **口径洞察**：LoCoMo 评测单元=单对话，每进程一棵完整树 → 对话级进程并行与串行**完全等价**（不同于 halumem record 内分片的 recall 低估/precision 虚高）→ GLM 限流下 2 进程安全，10 对话分 5 批或 2 路流水。
- 判分流量与被测同端点，计入限流预算；nohup 必须（单对话 ~6h > 30min 工具超时）。
- **验收标准（成绩单）**：
  - [ ] 总 QA/1986 + 五桶分数 + 与 halumem record1/2 同型短板对照（temporal↔版本史、multi-hop↔三层下钻、adversarial↔REFUSE）
  - [ ] 失败题按 evidence dia_id 抽样归因 ≥30 道（口径：检索 miss / 写入 miss / 判分误伤 / 拒答失守）
  - [ ] 结论落 README（历史参考分数节）+ memory 树
- 对照面：LoCoMo 论文基线、Mem0 报告值（标注「口径不可直接比」）。

### P5 — 沉淀｜1h
- `eval/locomo/README.md`（口径、判分差异、分数、坑）。
- memory 评测演进节点落结论。
- 候选后续（不在本计划）：event summarization 任务、open-domain 桶归因（是否需对话外知识）、841 题 open-domain 占 42% 的桶型解读。

## 风险与坑

| 风险 | 对策 |
|---|---|
| 判分口径差异（官方词面 F1 vs 自 LLM judge；adversarial 官方查短语 vs 自语义判拒） | 保持自口径与 halumem 对表；README 固定口径差异；可选输出官方 F1 次级对照 |
| 时间成本（串行 ~55-60h） | 对话级 2 并行 → ~30h；仍超预算则 --qps 抽 QA（写入不抽，只抽判分） |
| 30min 工具超时 | 全程 nohup + 日志 tail |
| token 用量未记录（halumem 遗留缺口） | 顺手在 runner 补 usage 采集（session 事件流里取） |
| runner 重构伤 halumem 入口 | 纯抽取不改逻辑；1-session 回归冒烟（QA 数值有噪声，看结构） |
| 2 个 cat5 带 answer 的边角 | adapter 统一 cat5→refuse，忽略 answer 字段 |
| 模型被 LoCoMo 预训练污染 | 无法排除（2024 公开数据集）；与 halumem 交叉解读，不单点定论 |

## 决策点（已拍板 2026-11-25）

- **D-A** ✅ runner 抽共享（eval/pi-live/runner.ts，halumem/locomo 两入口共用）。
- **D-B** ✅ QA 全量 1986（写入阶段不抽；时间超预算再启用 --qps）。
- **D-C** ✅ 被测 glm-5.3-flash + thinking high（与 halumem 对表；GLM-5.4 可作 P4 后复跑选项）。
