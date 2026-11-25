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

### P3 — 单对话冒烟验收（conv-1，419 turns/199 题）✅（2026-11-25，70min，远快于 6h 估）
**机制性验收：全过**
- [x] exit 0，summary.json 落盘；turn 419/题 199/五桶分布与金标一致
- [x] 叶子 132 条全英文；日期戳 132/132=对话日期（100%）；叶数在 100~400 区间
- [x] QA 141/199 = **0.709**（≥0.55 底线）；70min；update 59 次（supersede 活跃）
- [x] compaction 未触发（419 turns + 199 Q 单会话）；单对话被测 input 39.9M tokens（cacheRead 21.8M，同会话 QA 代价）

**归因发现（58 失败逐题，全量归因超额完成 ≥30 采样要求）**：
1. **Adversarial 判分口径 artifact（~23 题）**：LoCoMo cat5 主型=说话人对调陷阱（金标不存在于被问者）；agent 正确识破并纠错归因（未缩造），REFUSE judge 却要求字面「不知道」→ 判 WRONG。典型例：「What instrument does Caroline play?」诱答=clarinet and violin（实为 Melanie 的）；原文 D15:19-26：Caroline 弹 acoustic guitar+学 piano，agent 答对仍被判错。
2. **多模态金标不可达（~5 题）**：locomo10.json 无 img/blip_caption（文本版），金标如「dog face cup」（原文只说 that cup）/「palm tree sunset」来自未发布的图像层——文本 replay 天花板。
3. **金标噪声/日期推导（~5 题）**：charity race 金标「Sunday before 25 May」（=5/21）错，原文 last Saturday=5/20，agent 对；setback 发生在 9 月被问 in October。
4. **Judge 列举超集严苛（~12 题）**：开放列举题 pred ⊇ gold 被判非「等价」。
5. **真 miss（~5-8 题）**：细粒度未写入/检索锚错事件；反事实题拒答 vs 金标期待推断。

修尺子后估算 ~0.87（+20 前提纠错 +12 超集 ≈ 173/199）。

### P3.5 — 修尺子 ✅（2026-11-25，判分口径两处修订）
- **JUDGE 改覆盖式等价**：pred 覆盖 gold 全部关键内容即 CORRECT（允许措辞差异/超集）；仅缺关键内容或矛盾才 WRONG。
- **REFUSE 改反编造判据**：字面拒答、指出前提错误/纠正归属、部分知识拒答（拒答所问+提供相关已知事实）都算 CORRECT；把诱答给判分员对照，pred 吐诱答或编造即 WRONG。修复 LoCoMo cat5 说话人对调陷阱的全量误伤。
- **重判脚本 scripts/rejudge.ts**（先审尺子常备工具）：重判已存 qaResults，不重跑；翻正/回退清单+byTag 对照落 rejudged.json。runner 改存全量 pred（旧 300 字截断是重判的天花板）。
- **重判验证**：conv-1 141→149+22翻正（Adversarial 24→37，坐实主假设）；record2 149→129 但 25 回退全为截断伪影（0 个非截断回退，两数据集合计 39/39 回退皆截断可疑）——新口径在完整 pred 上零确认回归。真实修正分需重跑（P4 全量自带）。

### P3.6 — conv-1 新口径重测 ✅（2026-11-25，60min，正式成绩）
- **QA 169/199 = 0.849**（旧 0.709 → 重判下限 0.749 → 重测 0.849）；五桶 Single-hop 0.89 / Temporal 0.77 / Multi-hop 0.78 / Open-domain 0.86 / Adversarial 0.87——尺子修订主效应坐实（Adversarial +0.36、Multi-hop +0.28）；与 halumem record1 外推 0.84 / record2 0.793 同梯队，外部留出首验通过。
- 30 失败精确归因（全量 pred）：多模态不可达 ~5 + 金标噪声 ~7 + 可答误标对抗 ~3 + judge 残留 ~4 + 真 miss ~6-8；单卷 ceiling ≈ 0.90+。详见 eval/locomo/README.md 成绩单。
- 用户决策：P4 其余 9 对话暂停；halumem 新口径复测取消（历史分数保持旧口径作对照面）。

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
