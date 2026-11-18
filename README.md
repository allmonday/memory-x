# Memory X

> 一棵给 pi 的长期记忆树 —— [pi coding agent](https://github.com/earendil-works/pi) 的扩展，把日常对话中的结构性信息沉淀进一棵可演进的记忆树。

**你掌舵，它记图** —— 你在终端和 pi 正常工作；值得长期记住的结论、决策、实体关系，被写进一棵 Markdown 可读、SQLite 为真相、git 管版本的记忆树。下次对话，目录常驻注入，细节按需下钻。

## 架构

```
┌─ pi 扩展（@memory-x/pi-extension）────────────┐
│  memory_read / upsert / move / apply_outline  │
│  <memory> 目录段常驻注入（渐进披露）            │
│  /memory · /memory stats · /memory dump       │
├─ 核心库（@memory-x/core）─────────────────────┤
│  树语义：路径寻址 / [n] 消歧 / 编辑距离容错      │
│  幂等 upsert / 防环 move / applyOutline 重构    │
├─ 存储（B 案）────────────────────────────────┤
│  真相源  .memory/memory.db（物化 path 链路      │
│          + content 字段，为 RAG 预留）          │
│  镜像   MEMORY.md（可完整重建 db，git 管 diff）  │
│  安全   WAL 事务 + 原子写 + O_EXCL 文件锁        │
└──────────────────────────────────────────────┘
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

对话中模型自主读写；你也可以：

```
/memory                 # 看记忆目录
/memory stats           # 规模统计
/memory log             # 版本历史（change log）
/memory rollback <id>  # 回滚到指定版本（历史保留，可再回滚回来）
/memory dump --full     # 整树导出到文件
```

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

## 测试

```bash
npm test        # 56 项：文法/路径/操作/存储/版本回滚/检索/迁移/锁/fuzz
npm run eval     # 检索质量评估（hit@1/@3/MRR，题集本地保存）
npm run crash-verify   # 写入中 SIGKILL，验证文件完好
```

零运行时依赖（Node ≥ 22.19，`node:sqlite` + strip-types 直跑 TS）。

## 路线图

- [x] M0 核心库（解析/寻址/原子写/git）
- [x] M1 pi 扩展最小闭环（5 工具 + TOC 注入）
- [x] B 案存储（SQLite 真相 + 物化链路）
- [x] 版本历史与回滚（revisions change log，移植自 MindMap X MVCC 语义）
- [x] M3 检索（FTS + 自动召回 + 评估 0.73）
- [ ] M2 自动抽取（turn_end → codemodel 判断 → 入图）

详见 [PLAN.md](./PLAN.md)。

## License

MIT
