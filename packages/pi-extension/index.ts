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
  dumpTree,
  tocDigest,
} from "../core/src/index.ts";

const MEMORY_DIR = process.env.MEMORY_X_DIR || join(homedir(), "memory-x", "memory");
const SECTION_MAX_CHARS = 1600;
const READ_MAX_CHARS = 6000;

let cache: MemoryFile | null = null;

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
      return text(r.changed ? `已写入 ${r.path}（rev ${short(r.revision)}）` : `已存在，无需写入：${r.path}`);
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
        return text(r.changed ? `已重构 ${r.path}（rev ${short(r.revision)}）` : `内容无变化：${r.path}`);
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
    if (cachedToc === null) {
      const m = await memory();
      cachedToc = tocDigest(m.root, { maxChars: SECTION_MAX_CHARS });
    }
    const rules = [
      "你有一棵长期记忆树（markdown 大纲，存储在用户机器上）。目录（[n] = 子树叶子总数）：",
      cachedToc,
      "使用规则：",
      "- 需要背景时用 memory_read 按路径下钻，不要凭空猜测记忆内容",
      "- 不确定信息在哪个节点时先用 memory_search 检索（命中带完整链路）",
      "- 对话中出现跨会话有价值的结论/决策/实体关系/长期待办时，用 memory_upsert 主动记录（一条一事，带日期标注）",
      "- 结构性重构（新增子树、整理分支）用 memory_apply_outline，零散增补用 memory_upsert",
      "- 不确定路径时先读目录或用更浅路径试探，避免盲写",
    ];

    // 自动召回：用户输入 → FTS top-3 → 追加「相关记忆」段（零工具调用的兑底）
    if (event.messageType === "user" && typeof event.prompt === "string" && event.prompt.length >= 2) {
      try {
        const m = await memory();
        const hits = m.search(event.prompt, 3);
        if (hits.length > 0) {
          const lines = hits.map((h) => {
            const chain = [...h.ancestors, h.title].join(" › ");
            return `- ${chain}：${h.snippet.slice(0, 60)}`;
          });
          rules.push(
            "",
            "以下是与本次输入自动召回的相关记忆（确认可用；需要全文用 memory_read）：",
            ...lines,
          );
        }
      } catch {
        // 召回失败不阻断会话
      }
    }

    // sections: Record<string, string>，渲染为 <memory>…</memory>（prompt-customizer.ts 同款做法）
    event.systemPromptOptions.sections.memory = rules.join("\n");
  });

  // ---------- 命令 ----------

  pi.registerCommand("memory", {
    description: "Memory X：/memory 目录 | /memory stats 统计 | /memory dump [文件] [--full] 导出树",
    handler: async (args: string, ctx: any) => {
      const m = await memory();
      const tokens = args.trim().split(/\s+/).filter(Boolean);

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

function short(rev: string | null): string {
  return rev ? rev.slice(0, 7) : "-";
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
