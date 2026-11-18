# Memory X

> 一棵给 pi 的长期记忆树 —— [pi coding agent](https://github.com/earendil-works/pi) 的扩展，把日常对话中的结构性信息沉淀进一棵可演进的记忆树。

**你掌舵，它记图** —— 你在终端和 pi 正常工作；值得长期记住的结论、决策、实体关系，被写进一棵 SQLite 为真相、可检索、可回滚、可"做梦"整理的记忆树。下次对话，目录常驻注入，相关记忆自动召回。

## 架构

```
┌─ pi 扩展（@memory-x/pi-extension）───────────────────────┐
│  工具面：read / search / upsert / move /                  │
│          apply_outline / delete / stats / propose         │
│  注入（双 section，差分对齐）：                             │
│    <memory>        目录+规则（稳定，变更才补发）             │
│    <memory_recall> 本轮相关记忆（话题切换才换，自动召回）      │
├─ 检索（派生索引，可随时重建）──────────────────────────────┤
│  FTS5 trigram（≥3字，CJK 滑窗拆词）∪ LIKE（双字词兜底）      │
│  停用词过滤 · bm25 排序 · 访问频次/新鲜度信号加成             │
│  命中返回：完整链路 + 祖先/兄弟 + 片段（渐进披露）            │
├─ 核心库（@memory-x/core）────────────────────────────────┤
│  树语义：路径寻址 / [n] 消歧 / 编辑距离容错 / 幂等 upsert     │
│  applyOutline 子树重构 · applyTree 整树替换（整理）          │
│  LCS 行级 diff（整理方案审阅用）                             │
├─ 存储（B 案，单文件真相源）───────────────────────────────┤
│  真相源  .memory/memory.db（WAL 事务 + O_EXCL 文件锁）      │
│          nodes/leaves（物化 path 链路 + content 正文）      │
│  版本历史 revisions（整树快照 change log，保留 500 版）      │
│          回滚 = 落新版本（历史不改写，可前滚）                │
└──────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
git clone https://github.com/allmonday/memory-x.git

# 装进你的 pi（全局）
# ~/.pi/agent/settings.json:
#   "extensions": ["<clone路径>/packages/pi-extension/index.ts"]

# 或单次会话试用
pi -e <clone路径>/packages/pi-extension/index.ts
```

记忆数据默认在 `~/memory-x/memory/`（`MEMORY_X_DIR` 可改）。**你的记忆永远在本机**——这个仓库只有代码，不含任何数据。

## 使用

对话中模型自主读写检索；你的命令面：

```
/memory                    # 看记忆目录
/memory tidy               # 整理（做梦）：模型出方案草稿 → show 看 diff → apply 确认落盘
/memory tidy show|apply|discard
/memory log                # 版本历史（change log）
/memory rollback <id>      # 回滚到指定版本（历史保留，可再滚回来）
/memory stats              # 规模统计
/memory dump [--full] [文件]  # 整树导出
```

**整理（做梦）的安全设计**：方案只进草稿不落盘；整理模式下所有写工具被 `tool_call` 拦截器封禁；落盘前人审 diff（+N/-N 行）；apply 后仍可 rollback。

文法（严格模式，非法行直接报错）：

```markdown
# Memory

## 工作
### pi 生态调研
- RPC 模式与 SDK 模式共享 core 层 ← 2026-11-16

#### 待办
- 验证崩溃窗口

### 调研正文
```（fenced block = 节点完整信息，RAG 语料）
```
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_X_DIR` | `~/memory-x/memory` | 记忆仓目录 |
| `MEMORY_X_INJECT_MIN` | `1.0` | 自动召回注入分数闸门（噪音控制） |

## 测试与评估

```bash
npm test              # 63 项：文法/路径/操作/存储/版本回滚/检索/整理/迁移/锁/fuzz
npm run eval          # 检索质量评估（hit@1/@3/MRR；当前 0.73，题集本地保存不入库）
npm run crash-verify  # 写入中 SIGKILL，验证 db 完好（WAL）
```

零运行时依赖（**Node ≥ 23.6**，`node:sqlite` + 原生 TS 直跑；无需 npm install、无需系统 SQLite、运行时不碰 git）。

## 路线图

- [x] M0 核心库（解析/寻址/原子性/锁）
- [x] M1 pi 扩展最小闭环（工具 + TOC 注入）
- [x] B 案存储（SQLite 真相 + 物化链路 + content 正文）
- [x] 版本历史与回滚（revisions change log，移植自 MindMap X MVCC 语义）
- [x] M3 检索（FTS+LIKE 双通道、停用词、访问/新鲜度信号、自动召回闸门、评估设施）
- [x] 整理（做梦）：手动触发，草稿-人审-落盘三段式
- [ ] M2 自动抽取（turn_end → codemodel 判断 → 入图；自动做梦节奏）
- [ ] M5 语义向量层（bge-small-zh + RRF 融合，评估达标才保留）

详见 [PLAN.md](./PLAN.md)。

## License

MIT
