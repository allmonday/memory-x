/**
 * Memory X — pi 扩展（M1：手动写入闭环）
 *
 * 功能：
 * - 5 个工具：memory_read / memory_upsert / memory_move / memory_apply_outline / memory_stats
 * - before_agent_start：system prompt 注入记忆目录摘要（<memory> section，渐进披露）
 * - /memory 命令：查看目录与状态
 *
 * 配置：
 * - MEMORY_X_DIR：记忆仓目录（默认 ~/memory-x/memory）
 *
 * 试运行：pi -e ~/memory-x/packages/pi-extension/index.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  MemoryFile,
  diffLines,
  diffStats,
  dumpTree,
  formatDiff,
  lintTree,
  parseFragment,
  serializeMarkdown,
  tocDigest,
} from "../core/src/index.ts";

const MEMORY_DIR = process.env.MEMORY_X_DIR || join(homedir(), "memory-x", "memory");
const SECTION_MAX_CHARS = 1600;
const READ_MAX_CHARS = 6000;
/** 自动召回注入阈值：综合分低于此不注入（减噪；MEMORY_X_INJECT_MIN 可调） */
const AUTO_INJECT_MIN_SCORE = Number(process.env.MEMORY_X_INJECT_MIN ?? "1.0");

let cache: MemoryFile | null = null;

// ---------- 整理（做梦）模式状态 ----------
let tidyMode = false;
let tidyDraft: { outline: string; createdAt: string } | null = null;

const TIDY_WRITE_TOOLS = new Set(["memory_upsert", "memory_move", "memory_delete", "memory_apply_outline"]);

/** 整理模式下拦截写工具：方案只能走 memory_propose 草稿，确认后才落盘 */
function gateTidyWrites(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    if (tidyMode && TIDY_WRITE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: "整理模式进行中：直接写入已禁用。请用 memory_propose 提交整树方案，用户确认后经 /memory tidy apply 落盘",
      };
    }
    return undefined;
  });
}

async function memory(): Promise<MemoryFile> {
  if (!cache) cache = await MemoryFile.open(MEMORY_DIR);
  return cache;
}

/** 每次写后刷新目录缓存（before_agent_start 用） */
let cachedToc: string | null = null;
function invalidateToc(): void {
  cachedToc = null;
}

function text(t: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text: t }], details: {} };
}

const pathParam = {
  type: "string",
  description: "节点路径，如 工作/pi生态调研（兄弟重名用 项目[2] 消歧）",
};

export default function memoryExtension(pi: any): void {
  // ---------- 工具面 ----------

  pi.registerTool({
    name: "memory_read",
    label: "读记忆",
    description: "读取长期记忆树的指定子树（markdown 大纲）",
    promptSnippet: "读取长期记忆树子树",
    promptGuidelines: [
      "Use memory_read when the conversation touches topics likely present in long-term memory; navigate by path guided by the TOC in the <memory> section.",
    ],
    parameters: {
      type: "object",
      properties: { path: pathParam },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: { path: string }) {
      const m = await memory();
      const md = m.renderSection(params.path);
      if (md !== null) m.recordAccess(params.path); // 访问信号（P5）
      if (md === null) {
        const tops = m.root.children.map((c) => c.title).join("、") || "（空）";
        return text(`路径不存在：${params.path}\n当前顶层节点：${tops}`);
      }
      if (md.length > READ_MAX_CHARS) {
        return text(`${md.slice(0, READ_MAX_CHARS)}\n…（已截断，请用更深的路径分段读取）`);
      }
      return text(md);
    },
  });

  pi.registerTool({
    name: "memory_upsert",
    label: "写记忆",
    description: "新增/更新一条叶子事实（精确重复为幂等 no-op；路径缺失会自动创建中间节点）",
    promptSnippet: "写入一条长期记忆",
    promptGuidelines: [
      "Use memory_upsert when the conversation produces a conclusion, decision, entity relation, or long-term todo worth keeping across sessions. One fact per call; timestamp with today's date in the leaf text.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        leaf: { type: "string", description: "一条叶子事实（短句，可带 ← 日期 标注）" },
      },
      required: ["path", "leaf"],
    },
    async execute(_toolCallId: string, params: { path: string; leaf: string }) {
      const m = await memory();
      const r = await m.upsertNode(params.path, params.leaf);
      if (r.changed) invalidateToc();
      // 结构守卫（非阻断，只给模型提示）
      const hints: string[] = [];
      const depth = r.path.split("/").length;
      if (depth > 4) hints.push(`路径已达 ${depth} 层——深埋的内容通常是新主题信号，考虑提升为兄弟`);
      const sec = m.readSection(r.path);
      if (sec && sec.node.leaves.length > 20) hints.push(`该节点叶子已达 ${sec.node.leaves.length} 条——考虑按主题分叉`);
      return text(
        r.changed
          ? `已写入 ${r.path}（版本 #${r.revision}，可用 /memory rollback 回滚）${hints.length ? "\n⚠️ " + hints.join("；") : ""}`
          : `已存在，无需写入：${r.path}`,
      );
    },
    },
  });

  pi.registerTool({
    name: "memory_move",
    label: "移动记忆",
    description: "把子树移动到目标节点之下",
    parameters: {
      type: "object",
      properties: {
        from: pathParam,
        to: { type: "string", description: "目标父节点路径" },
      },
      required: ["from", "to"],
    },
    async execute(_toolCallId: string, params: { from: string; to: string }) {
      const m = await memory();
      const r = await m.moveNode(params.from, params.to);
      if (r.ok) invalidateToc();
      return text(r.ok ? `已移动 ${params.from} → ${params.to}` : `移动失败（路径不存在或构成环）`);
    },
  });

  pi.registerTool({
    name: "memory_apply_outline",
    label: "重构记忆子树",
    description:
      "用一份 outline 整体替换目标节点的内容（叶子+子树）。outline 文法：标题行（##/###…，相对层级）+ 列表项，首个标题前的列表项归目标节点自身。适合结构性重构，改动大时优于多次 upsert",
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        outline: { type: "string", description: "markdown outline 片段" },
      },
      required: ["path", "outline"],
    },
    async execute(_toolCallId: string, params: { path: string; outline: string }) {
      const m = await memory();
      try {
        const r = await m.applyOutline(params.path, params.outline);
        if (r.changed) invalidateToc();
        return text(r.changed ? `已重构 ${r.path}（版本 #${r.revision}）` : `内容无变化：${r.path}`);
      } catch (e) {
        return text(`outline 应用失败：${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "搜记忆",
    description:
      "在长期记忆树中检索（FTS+兜底）：返回命中节点的完整链路、祖先/兄弟、命中片段。不确定信息在哪个节点时先用它，再 memory_read 取全文",
    promptSnippet: "检索长期记忆树（返回链路）",
    promptGuidelines: [
      "Use memory_search instead of guessing node paths when the topic may relate to stored memory but the TOC does not clearly show where it lives.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词（关键词、话题、同义改写均可）" },
        top_k: { type: "number", description: "返回条数（默认 5）" },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: { query: string; top_k?: number }) {
      const m = await memory();
      const hits = m.search(params.query, params.top_k ?? 5);
      if (hits.length === 0) {
        return text(`无命中：「${params.query}」。可换关键词，或 memory_read 目录下钻。`);
      }
      const lines = hits.map((h, i) => {
        const chain = [...h.ancestors, h.title].join(" › ");
        const meta = [h.hasContent ? "有完整信息" : null, h.leafCount > 0 ? `${h.leafCount} 条事实` : null]
          .filter(Boolean)
          .join("，");
        return `${i + 1}. ${chain}${meta ? `（${meta}）` : ""}\n   ${h.snippet}`;
      });
      return text(`命中 ${hits.length} 条：\n${lines.join("\n")}\n（取全文：memory_read 对应路径）`);
    },
  });

  pi.registerTool({
    name: "memory_delete",
    label: "删除记忆子树",
    description:
      "删除指定子树（含共全部叶子与后代，可 /memory rollback 回滚）。仅在不有意义地清理元余/过时内容时使用",
    parameters: {
      type: "object",
      properties: { path: pathParam },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: { path: string }) {
      const m = await memory();
      const r = await m.deleteNode(params.path);
      if (r.ok) invalidateToc();
      return text(
        r.ok
          ? `已删除 ${params.path}（版本 #${r.revision}，可 /memory rollback 回滚）`
          : `删除失败（路径不存在）：${params.path}`,
      );
    },
  });

  pi.registerTool({
    name: "memory_propose",
    label: "提交整理方案",
    description:
      "整理模式专用：提交整理后的完整记忆树方案（草稿，不落盘）。仅在收到[整理任务]时使用；用后提醒用户 /memory tidy show 查看与 /memory tidy apply 确认",
    parameters: {
      type: "object",
      properties: {
        outline: {
          type: "string",
          description: "整理后的完整树（markdown outline，H2=顶层域，与原树同文法）",
        },
        summary: { type: "string", description: "一句话说明本次整理做了什么（给用户看）" },
      },
      required: ["outline"],
    },
    async execute(_toolCallId: string, params: { outline: string; summary?: string }) {
      // 干跑校验：能解析、规模合理，才收草稿
      try {
        const frag = parseFragment(params.outline);
        if (frag.leaves.length > 0) throw new Error("根节点下不应有列表项");
        const count = (ns: any[]): number =>
          ns.reduce((s: number, x: any) => s + 1 + x.leaves.length + count(x.children), 0);
        const total = count(frag.children);
        if (total > 3000) throw new Error(`方案过大（${total} > 3000 条目）`);
        tidyDraft = { outline: params.outline, createdAt: new Date().toISOString() };
        return text(
          `方案已收草稿（未落盘）：${total} 个条目。${params.summary ? `整理说明：${params.summary}\n` : ""}请提醒用户：/memory tidy show 查看 diff，/memory tidy apply 确认落盘，/memory tidy discard 丢弃`,
        );
      } catch (e) {
        return text(`方案校验失败（未收草稿）：${(e as Error).message}`);
      }
    },
  });

  gateTidyWrites(pi);

  pi.registerTool({
    name: "memory_stats",
    label: "记忆统计",
    description: "记忆树的规模统计（节点数/叶子数/顶层域）",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const m = await memory();
      const stats = collectStats(m.root);
      return text(
        `节点 ${stats.nodes}，叶子 ${stats.leaves}，深度 ${stats.depth}\n顶层：${m.root.children
          .map((c) => c.title)
          .join("、") || "（空）"}`,
      );
    },
  });

  // ---------- system prompt 注入（P2：只给目录，不给内容） ----------

  pi.on("before_agent_start", async (event: any) => {
    // 稳定段（目录+规则）：内容不变 → pi 差分为空 → 不重发不破缓存
    if (cachedToc === null) {
      const m = await memory();
      cachedToc = tocDigest(m.root, { maxChars: SECTION_MAX_CHARS });
    }
    event.systemPromptOptions.sections.memory = [
      "长期记忆树目录（[n]=子树叶子总数，机器本地存储）：",
      cachedToc,
      "规则：需背景先 memory_read 下钻；不确定位置先 memory_search；出现跨会话价值的结论/决策/实体/待办时 memory_upsert 主动记（一条一事+日期）；重构用 memory_apply_outline；勿猜路径。",
    ].join("\n");

    // 召回段（独立 section）：每轮随 prompt 变化，但只重发这小块，不动大段。
    // 命中集不变 → 字符串相同 → 差分为空 → 零成本。
    let recallBody: string | null = null;
    if (event.messageType === "user" && typeof event.prompt === "string" && event.prompt.length >= 2) {
      try {
        const m = await memory();
        const hits = m.search(event.prompt, 3).filter((h) => h.score >= AUTO_INJECT_MIN_SCORE);
        if (hits.length > 0) {
          const lines = hits.map((h) => {
            const chain = [...h.ancestors, h.title].join(" › ");
            return `- ${chain}：${h.snippet.slice(0, 60)}`;
          });
          recallBody = ["相关记忆（自动召回，需全文用 memory_read）：", ...lines].join("\n");
        }
      } catch {
        // 召回失败不阻断会话
      }
    }
    if (recallBody !== null) {
      event.systemPromptOptions.sections.memory_recall = recallBody;
    } else {
      delete event.systemPromptOptions.sections.memory_recall;
    }
  });

  // ---------- 命令 ----------

  pi.registerCommand("memory", {
    description: "Memory X：/memory 目录 | tidy 整理(做梦) | log 历史 | rollback <id> | stats | dump",
    handler: async (args: string, ctx: any) => {
      const m = await memory();
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      if (tokens[0] === "lint") {
        const m = await memory();
        const issues = lintTree(m.root);
        if (issues.length === 0) {
          ctx.ui.notify("结构健康 ✓（深度/广度/叶子/重名/时间性命名均达标）", "info");
          return;
        }
        const warns = issues.filter((i) => i.level === "warn");
        const infos = issues.filter((i) => i.level === "info");
        ctx.ui.notify(
          `结构体检：${warns.length} 项警告，${infos.length} 项建议\n\n${issues
            .map((i) => `[${i.level === "warn" ? "⚠" : "ℹ"}] ${i.rule} @ ${i.path || "(根)"}\n    ${i.message}`)
            .join("\n")}\n\n修复：/memory tidy（模型会优先处理以上问题）`,
          "info",
        );
        return;
      }

      if (tokens[0] === "tidy") {
        const sub = tokens[1];
        const m = await memory();

        if (!sub) {
          // 发起整理：整树交给模型分析，方案只进草稿；整理模式下写工具被拦截
          tidyMode = true;
          tidyDraft = null;
          const tree = serializeMarkdown(m.root);
          const lint = lintTree(m.root);
          pi.sendMessage(
            {
              customType: "memory-tidy",
              content: [
                "[整理任务] 请分析下面的记忆树并给出整理后的完整新树方案。",
                "整理目标：合并重复/分散的事实；理顺层级与命名；精简冗长叶子（保留要点，不丢信息）；剔除明显过期内容。",
                ...(lint.length > 0
                  ? [
                      "结构体检发现以下问题，方案必须优先处理：",
                      ...lint.map((i) => `- [${i.rule}] ${i.path || "(根)"}：${i.message}`),
                    ]
                  : []),,
                "约束：保持 markdown outline 文法（H2=顶层域，叶子一行一事）；不要新建过深层级（≤5）；时间戳保留。",
                "【禁止调用任何写工具（upsert/move/delete/apply_outline）——它们在整理模式下被拦截】。",
                "完成后调用 memory_propose 提交完整新树（outline 参数）+ 一句话整理说明，然后告知用户用 /memory tidy show 查看、/memory tidy apply 确认。",
                "",
                "当前记忆树全文：",
                "```",
                tree,
                "```",
              ].join("\n"),
              display: true,
            },
            { triggerTurn: true },
          );
          ctx.ui.notify("整理任务已发起（做梦中…）：模型将提出方案草稿，写工具已临时禁用", "info");
          return;
        }

        if (sub === "show") {
          if (!tidyDraft) {
            ctx.ui.notify("没有待审方案。先用 /memory tidy 发起整理", "error");
            return;
          }
          const before = serializeMarkdown(m.root).split("\n");
          const proposed: any = { title: "Memory", leaves: [], children: parseFragment(tidyDraft.outline).children };
          const after = serializeMarkdown(proposed).split("\n");
          const diff = diffLines(before, after);
          const { added, removed } = diffStats(diff);
          ctx.ui.notify(
            `方案草稿（${tidyDraft.createdAt.slice(0, 16).replace("T", " ")}）：+${added} / -${removed} 行\n\n${formatDiff(diff)}\n\n确认：/memory tidy apply · 丢弃：/memory tidy discard`,
            "info",
          );
          return;
        }

        if (sub === "apply") {
          if (!tidyDraft) {
            ctx.ui.notify("没有待审方案", "error");
            return;
          }
          const r = await m.applyTree(tidyDraft.outline);
          tidyMode = false;
          tidyDraft = null;
          invalidateToc();
          ctx.ui.notify(
            r.ok ? `整理已落盘（版本 #${r.revision}，不合适可 /memory rollback 回滚）` : `落盘失败：${r.path}`,
            "info",
          );
          return;
        }

        if (sub === "discard") {
          tidyMode = false;
          tidyDraft = null;
          ctx.ui.notify("已丢弃方案，写工具解禁", "info");
          return;
        }

        ctx.ui.notify("用法：/memory tidy [show|apply|discard]", "error");
        return;
      }

      if (tokens[0] === "log") {
        const n = Number(tokens[1] ?? 15);
        const revs = m.listRevisions(Number.isFinite(n) && n > 0 ? n : 15);
        if (revs.length === 0) {
          ctx.ui.notify("暂无版本历史", "info");
          return;
        }
        const lines = revs.map((r) => `#${r.id} [${r.created_at}] ${r.op}${r.path ? ` ${r.path}` : ""}`);
        ctx.ui.notify(`版本历史（最近 ${revs.length} 条，回滚：/memory rollback <id>）：\n${lines.join("\n")}`, "info");
        return;
      }

      if (tokens[0] === "rollback") {
        const id = Number(tokens[1]);
        if (!Number.isInteger(id) || id <= 0) {
          ctx.ui.notify("用法：/memory rollback <版本id>（用 /memory log 查询）", "error");
          return;
        }
        const r = await m.restoreRevision(id);
        if (r.ok) {
          invalidateToc();
          ctx.ui.notify(r.changed ? `已回滚到 #${id}（新版本 #${r.revision}，历史保留，可再回滚回来）` : `当前已是 #${id} 的状态，无需回滚`, "info");
        } else {
          ctx.ui.notify(`版本 #${id} 不存在（用 /memory log 查询可用版本）`, "error");
        }
        return;
      }

      if (tokens[0] === "stats") {
        const s = collectStats(m.root);
        ctx.ui.notify(`节点 ${s.nodes} / 叶子 ${s.leaves} / 深度 ${s.depth} · ${MEMORY_DIR}`, "info");
        return;
      }

      if (tokens[0] === "dump") {
        const full = tokens.includes("--full");
        const fileArg = tokens.slice(1).find((t) => !t.startsWith("--"));
        const { writeFile } = await import("node:fs/promises");
        const { resolve } = await import("node:path");
        const target = resolve(fileArg ?? "memory-tree.txt");
        const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
        const body = dumpTree(m.root, { full });
        await writeFile(target, `# Memory X tree dump — ${stamp}${full ? "（含叶子）" : ""}\n\n${body}\n`, "utf8");
        ctx.ui.notify(`已导出 ${full ? "完整树（含叶子）" : "结构树"} → ${target}`, "info");
        return;
      }

      ctx.ui.notify(`记忆目录（${MEMORY_DIR}）：\n${tocDigest(m.root)}`, "info");
    },
  });
}

function collectStats(root: any): { nodes: number; leaves: number; depth: number } {
  let nodes = 0;
  let leaves = 0;
  let depth = 0;
  const walk = (n: any, d: number) => {
    nodes++;
    leaves += n.leaves.length;
    depth = Math.max(depth, d);
    for (const c of n.children) walk(c, d + 1);
  };
  for (const c of root.children) walk(c, 1);
  return { nodes, leaves, depth };
}
