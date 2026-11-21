/**
 * Memory X — pi 扩展（M1：手动写入闭环）
 *
 * 功能：
 * - 工具：read / upsert / update / write_note / summary / move / delete / search / evidence / propose / stats
 * - before_agent_start：system prompt 注入记忆目录摘要（<memory> section，渐进披露）
 * - /memory 命令：查看目录与状态
 *
 * 配置：
 * - MEMORY_X_DIR：记忆仓目录（默认 ~/memory-x/memory）
 *
 * 试运行：pi -e ~/memory-x/packages/pi-extension/index.ts
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryFile,
  TREE_OP_NAMES,
  diffToChangeRows,
  dumpTree,
  enumerateNodePaths,
  lintTree,
  serializeMarkdown,
  serializeOutline,
  serializeSubtree,
  tocDigest,
  type TreeOp,
} from "../core/src/index.ts";

const MEMORY_DIR = process.env.MEMORY_X_DIR || join(homedir(), "memory-x", "memory");
const SECTION_MAX_CHARS = 1600;
const READ_MAX_CHARS = 6000;
/** 自动召回注入阈值：综合分低于此不注入（减噪；MEMORY_X_INJECT_MIN 可调） */
const AUTO_INJECT_MIN_SCORE = Number(process.env.MEMORY_X_INJECT_MIN ?? "1.0");

/**
 * 记忆写入规范（借 ASD-STE 原则）：短句、一句一事、主动语态、术语一致、去修饰；
 * 保留人名/日期/数字/专有名词；原文或摘要重要时用引用块（> …）原样保留，不要改写。
 */
const WRITE_STYLE = "短句、一句一事、主动语态、术语一致、去修饰；保留人名/日期/数字/专有名词；原文或摘要重要时用引用块（> …）原样保留；事实行用与对话相同的语言书写（对话是英文就写英文，不要换语言）。";

/** 新叶子末尾机械附加日期（已含则不重复）——时间锚点不依赖模型自觉；MEMORY_X_DATE 可显式指定“今天”（replay/测试用） */
function withDate(leaf: string): string {
  if (/←\s*\d{4}-\d{2}-\d{2}/.test(leaf)) return leaf;
  const env = process.env.MEMORY_X_DATE;
  let today: string;
  if (env && /^\d{4}-\d{2}-\d{2}$/.test(env)) today = env;
  else {
    const d = new Date();
    today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return `${leaf} ← ${today}`;
}

let cache: MemoryFile | null = null;

// ---------- 采集（P4）状态 ----------
let lastUserPrompt: string | null = null;
const CAPTURE_ON = process.env.MEMORY_X_CAPTURE !== "off";
const EPISODE_MAX = Number(process.env.MEMORY_X_EPISODE_MAX ?? "0"); // 0=不裁剪（默认永久保留；设正数可恢复滚动窗口）
const EPISODE_TEXT_MAX = 4000;

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 从消息里尽力抽取纯文本（不同 message 形状兜底）。 */
function extractMessageText(msg: any): string {
  if (msg == null) return "";
  const c = msg.content ?? msg.text;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p?.text) return p.text;
        if (p?.type === "tool_use") return `[tool_use ${p.name ?? ""}] ${safeJson(p.input)}`;
        if (p?.type === "tool_result") return extractMessageText({ content: p.content });
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function clampEpisodeText(s: string): string {
  return s.length > EPISODE_TEXT_MAX ? `${s.slice(0, EPISODE_TEXT_MAX)}…（截断）` : s;
}

// ---------- 整理（做梦）模式状态 ----------
let tidyMode = false;
/** 整理作用域：null=整棵树（全局），否则为目标节点路径（局部整理） */
let tidyScope: string | null = null;

const TIDY_WRITE_TOOLS = new Set(["memory_upsert", "memory_update", "memory_write_note", "memory_summary", "memory_link_evidence", "memory_move", "memory_delete"]);

/** 整理模式下拦截写工具：方案只能走 memory_propose 草稿，确认后才落盘 */
function gateTidyWrites(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    if (tidyMode && TIDY_WRITE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: "整理模式进行中：直接写入已禁用。请用 memory_propose 提交整理操作（会直接落盘为一个可回滚的版本）",
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

/** 仓库根（pi-extension/index.ts 上两级） */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 探测某端口的只读 UI 是否在响应（任意 session/终端启动的独立进程） */
async function uiAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 轮询等待 UI 就绪（终端唤起后确认真的起来了） */
async function waitUi(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await uiAlive(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 在独立终端里启动 standalone UI 进程，使其独立于本 pi session。
 * 前台运行：关闭该终端 / Ctrl-C 即停（不做 daemon/pidfile）。
 * 返回是否成功唤起终端；找不到可用终端时由调用方退化为提示手动执行。
 */
async function spawnUiInTerminal(argv: string[], cwd: string): Promise<boolean> {
  const { spawn, spawnSync } = await import("node:child_process");
  const has = (bin: string): boolean =>
    spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
  const q = (s: string) => JSON.stringify(s);
  const line = `cd ${q(cwd)} && ${argv.map(q).join(" ")}`;

  const launch = (bin: string, args: string[]): boolean => {
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  };

  if (process.platform === "darwin") {
    // Terminal.app 是 macOS 标配
    return launch("osascript", [
      "-e", `tell application "Terminal" to do script ${JSON.stringify(line)}`,
      "-e", `tell application "Terminal" to activate`,
    ]);
  }
  if (process.platform === "win32") {
    return launch("cmd", ["/c", "start", "", "cmd", "/k", line]);
  }
  // Linux：探测常见终端模拟器
  const candidates: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["-e", "bash", "-lc", line]],
    ["gnome-terminal", ["--", "bash", "-lc", line]],
    ["konsole", ["-e", "bash", "-lc", line]],
    ["xfce4-terminal", ["-x", "bash", "-lc", line]],
    ["alacritty", ["-e", "bash", "-lc", line]],
    ["kitty", ["bash", "-lc", line]],
    ["xterm", ["-e", "bash", "-lc", line]],
  ];
  for (const [bin, args] of candidates) if (has(bin)) return launch(bin, args);
  return false;
}

function text(
  t: string,
  details: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text: t }], details };
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
      const r = m.readSection(params.path);
      if (r === null) {
        const tops = m.root.children.map((c) => c.title).join("、") || "（空）";
        return text(`路径不存在：${params.path}\n当前顶层节点：${tops}`);
      }
      m.recordAccess(params.path); // 访问信号（P5）
      const md = serializeSubtree(r.node);
      // 改写计数：不含创建，只数旧值被取代过的次数（0 = 从未被改写，不标注）
      const hist = m.historyCounts().get(r.node.uid ?? "") ?? 0;
      const summary = m.getSummary(params.path);
      const head =
        (summary ? `> 摘要：${summary}\n` : "") +
        (hist > 0 ? `> 历史：${hist} 次改写（旧值可 /memory changes 回溯）\n` : "") +
        "\n";
      const details = { historyCount: hist };
      if (md.length > READ_MAX_CHARS) {
        return text(`${head}${md.slice(0, READ_MAX_CHARS)}\n…（已截断，请用更深的路径分段读取）`, details);
      }
      return text(head + md, details);
    },
  });

  pi.registerTool({
    name: "memory_upsert",
    label: "写记忆",
    description: "新增/更新一条叶子事实（精确重复为幂等 no-op；路径缺失会自动创建中间节点）",
    promptSnippet: "写入一条长期记忆",
    promptGuidelines: [
      "Use memory_upsert when the conversation produces a conclusion, decision, entity relation, or long-term todo worth keeping across sessions. One fact per call; the write date is stamped automatically.",
      "Write in the memory write style: short sentences, one fact per leaf, active voice, consistent terms, no vague words. Keep names, dates, and numbers. Write leaves in the SAME LANGUAGE as the conversation (English dialogue → English leaves). If the original wording matters, keep it verbatim as a quote (> …).",
    ],
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        leaf: { type: "string", description: "一条叶子事实（短句；写入日期自动附加，无需手写）" },
      },
      required: ["path", "leaf"],
    },
    async execute(_toolCallId: string, params: { path: string; leaf: string }) {
      const m = await memory();
      const r = await m.upsertNode(params.path, withDate(params.leaf));
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
  });

  pi.registerTool({
    name: "memory_update",
    label: "更新记忆",
    description:
      "原地替换某节点内的一条叶子事实（supersede/更新）。match = 要被替换的旧叶子原文，必须在该节点内**精确且唯一**命中，否则不做任何改动。用于「阶段性变化」：状态/计划/偏好变了、或旧结论被推翻。旧值被替换后即从检索中消失（变更落 revisions 可回滚）。",
    promptSnippet: "替换一条过时的记忆",
    promptGuidelines: [
      "Use memory_update when new information SUPERSEDES an existing leaf (state changed / plan updated / fact corrected) instead of adding a duplicate. `match` must be the exact old leaf text; read the node first (memory_read) to copy it verbatim. If it is not unique in the node, nothing changes.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        match: { type: "string", description: "要被替换的旧叶子原文（在该节点内需唯一命中）" },
        leaf: { type: "string", description: "新的叶子文本（写入日期自动附加）" },
      },
      required: ["path", "match", "leaf"],
    },
    async execute(_toolCallId: string, params: { path: string; match: string; leaf: string }) {
      const m = await memory();
      const r = await m.updateNode(params.path, params.match, withDate(params.leaf));
      if (!r.ok) {
        return text(
          `未替换：在「${params.path}」内未唯一命中旧原文（或路径不存在）。先用 memory_read 查看该节点、逐字复制要替换的叶子。`,
        );
      }
      if (r.changed) invalidateToc();
      return text(r.changed ? `已替换 ${r.path}（版本 #${r.revision}）` : `新旧相同，无需替换：${r.path}`);
    },
  });

  pi.registerTool({
    name: "memory_write_note",
    label: "写节点完整信息",
    description:
      "写入/更新节点的「完整信息」（content，RAG 语料）。当某节点信息量超出一条叶子（长正文、结构化说明、清单、对比、步骤、代码）时用它。请用 Markdown 组织（标题/列表/表格/引用/行内代码/围栏代码），UI 会按 Markdown 渲染；不要把长正文塞进叶子。遵守写入规范：短句、一句一事、术语一致、去修饰；原文或摘要重要时用引用块（> …）原样保留。",
    promptSnippet: "写入节点完整信息（Markdown 正文）",
    promptGuidelines: [
      "Use memory_write_note for a node's long-form body (the ◆ 完整信息), not memory_upsert — leaves are one-line facts only.",
      "Write that body as Markdown (headings, lists, tables, quotes, code fences); the UI renders it. Keep it self-contained and factual.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        content: { type: "string", description: "节点的完整信息（Markdown 文本，可含围栏代码块）" },
      },
      required: ["path", "content"],
    },
    async execute(_toolCallId: string, params: { path: string; content: string }) {
      const m = await memory();
      const r = await m.writeNote(params.path, params.content);
      if (r.changed) invalidateToc();
      return text(
        r.ok
          ? r.changed
            ? `已写入 ${r.path} 的完整信息（版本 #${r.revision}，可用 /memory rollback 回滚）`
            : `内容无变化：${params.path}`
          : `路径不存在：${params.path}（先用 memory_read 确认路径）`,
      );
    },
  });

  pi.registerTool({
    name: "memory_summary",
    label: "写节点摘要",
    description:
      "写入/刷新节点的「摘要」（L0 一行，用于目录导航；不是事实，事实仍放叶子/content）。省略 text 时只回显当前有效摘要；text 传空串则清除显式摘要（回退自动推导）。",
    promptSnippet: "写节点摘要（导航用一行）",
    promptGuidelines: [
      "Use memory_summary to give a node a concise one-line description so the TOC is scannable without reading the whole node. It is navigation only, not a fact.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        text: { type: "string", description: "摘要文本（一行，≤~120 字）；省略则只读取当前摘要" },
      },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: { path: string; text?: string }) {
      const m = await memory();
      if (params.text === undefined) {
        return text(`${params.path} 摘要：${m.getSummary(params.path) || "（无）"}`);
      }
      const r = await m.writeSummary(params.path, params.text);
      if (r.changed) invalidateToc();
      return text(
        r.ok
          ? r.changed
            ? `已写入 ${r.path} 的摘要（版本 #${r.revision}）`
            : `摘要无变化：${params.path}`
          : `路径不存在：${params.path}（先用 memory_read 确认路径）`,
      );
    },
  });

  pi.registerTool({
    name: "memory_evidence",
    label: "查记忆来源",
    description:
      "查询某条记忆的原始来源事件（episodes）。给 path 返回该节点已挂来源；再给 leaf（叶子原文）则只查该叶子的来源。",
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        leaf: { type: "string", description: "可选：叶子原文，精确查该条来源" },
      },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: { path: string; leaf?: string }) {
      const m = await memory();
      const refs = m.evidenceFor(params.path, params.leaf);
      if (refs.length === 0) return text(`「${params.path}」暂无可追溯来源（未链接 episode）。`);
      const ids = [...new Set(refs.map((r) => r.episodeId))];
      const eps = m.getEpisodes(ids);
      const byId = new Map(eps.map((e) => [e.id, e]));
      const lines = ids.map((id) => {
        const e = byId.get(id);
        return e ? `#${e.id} [${e.role}/${e.kind}] ${e.text.slice(0, 300)}` : `#${id}（事件已裁剪）`;
      });
      return text(`来源事件（${ids.length} 条）：\n${lines.join("\n")}`);
    },
  });

  pi.registerTool({
    name: "memory_link_evidence",
    label: "挂记忆来源",
    description:
      "把某条叶子记忆链接到原始来源事件（episode id），使结论可追溯（如「从第 N 条对话/输出得出」）。leaf 须在该节点内存在。",
    parameters: {
      type: "object",
      properties: {
        path: pathParam,
        leaf: { type: "string", description: "叶子原文（须在该节点内存在）" },
        episode_ids: { type: "array", items: { type: "number" }, description: "来源事件 id 列表" },
      },
      required: ["path", "leaf", "episode_ids"],
    },
    async execute(_toolCallId: string, params: { path: string; leaf: string; episode_ids: number[] }) {
      const m = await memory();
      const sec = m.readSection(params.path);
      if (!sec) return text(`路径不存在：${params.path}`);
      if (!sec.node.leaves.includes(params.leaf)) {
        return text(`该节点内不存在这条叶子，未链接：${params.leaf}`);
      }
      m.linkEvidence(params.path, params.leaf, params.episode_ids);
      return text(`已把「${params.leaf}」链接到 ${params.episode_ids.length} 条来源事件（${params.episode_ids.join(", ")}）`);
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
    name: "memory_search",
    label: "搜记忆",
    description:
      "在长期记忆树中检索（FTS+兜底）：返回命中节点的完整链路、祖先/兄弟、命中片段。不确定信息在哪个节点时先用它，再 memory_read 取全文。可用 scope 限定在某个节点子树内检索",
    promptSnippet: "检索长期记忆树（返回链路）",
    promptGuidelines: [
      "Use memory_search instead of guessing node paths when the topic may relate to stored memory but the TOC does not clearly show where it lives.",
      "When you already know the relevant subtree (a project/topic node), pass scope to search only within it instead of the whole tree.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词（关键词、话题、同义改写均可）" },
        scope: { type: "string", description: "可选：限定检索的节点路径（只搜该节点及其子树）" },
        top_k: { type: "number", description: "返回条数（默认 5）" },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: { query: string; scope?: string; top_k?: number }) {
      const m = await memory();
      const hits = m.search(params.query, params.top_k ?? 5, params.scope);
      if (hits.length === 0) {
        const scoped = params.scope ? `（范围：${params.scope}）` : "";
        return text(`无命中：「${params.query}」${scoped}。可换关键词，或 memory_read 目录下钻。`);
      }
      const lines = hits.map((h, i) => {
        const chain = [...h.ancestors, h.title].join(" › ");
        const meta = [h.hasContent ? "有完整信息" : null, h.leafCount > 0 ? `${h.leafCount} 条事实` : null]
          .filter(Boolean)
          .join("，");
        return `${i + 1}. ${chain}${meta ? `（${meta}）` : ""}\n   ${h.summary ? `${h.summary}\n   ` : ""}${h.snippet}`;
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
    label: "提交整理并落盘",
    description:
      "整理模式专用：提交结构化的操作列表并**直接落盘**为一个版本（可 /memory rollback 回滚）。仅在收到[整理任务]时使用；落盘后在回复里给出本版本变更摘要与回滚命令",
    parameters: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description:
            "结构化操作列表（按序应用）。op 与必填字段：add_leaf{path,leaf} / update_leaf{path,match,leaf} / remove_leaf{path,match} / rename{path,title} / move{from,to} / add_node{parent,title} / delete{path} / set_note{path,content} / set_summary{path,summary}。match 须为节点内**精确且唯一**的叶子原文。路径为物化规范路径。",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: TREE_OP_NAMES as unknown as string[] },
              path: { type: "string" },
              leaf: { type: "string" },
              match: { type: "string" },
              title: { type: "string" },
              from: { type: "string" },
              to: { type: "string" },
              parent: { type: "string" },
              content: { type: "string" },
              summary: { type: "string" },
            },
            required: ["op"],
          },
        },
        summary: { type: "string", description: "一句话说明本次整理做了什么（给用户看）" },
      },
      required: ["ops"],
    },
    async execute(_toolCallId: string, params: { ops: TreeOp[]; summary?: string }) {
      try {
        if (!Array.isArray(params.ops) || params.ops.length === 0) throw new Error("ops 为空");
        if (params.ops.length > 300) throw new Error(`操作过多（${params.ops.length} > 300）——缩小范围或分批`);
        const m = await memory();
        // 局部整理：路径必须落在目标子树内（防越界改动）
        if (tidyScope !== null) {
          const inScope = (p: string) => p === tidyScope || p.startsWith(`${tidyScope}/`);
          const bad = params.ops.find((o) =>
            Object.entries(o as Record<string, unknown>).some(
              ([k, v]) => /^(path|from|to|parent)$/.test(k) && typeof v === "string" && !inScope(v),
            ),
          );
          if (bad) throw new Error(`操作超出整理范围「${tidyScope}」：${JSON.stringify(bad)}`);
        }
        const scopeLabel = tidyScope === null ? "整棵树" : `节点「${tidyScope}」`;
        // 干跑校验（不改树）：全部操作能在克隆树上跑通，先拿变更预览
        const preview = m.previewOps(params.ops);
        if (!preview.ok) throw new Error(preview.error);
        const rows = diffToChangeRows(preview.diff);
        const prevId = m.listRevisions(1)[0]?.id; // 落盘前的当前版本＝本次 tidy 的回滚目标
        // 直接落盘：整批一个版本
        const r = await m.applyOps(params.ops, params.summary);
        tidyMode = false;
        tidyScope = null;
        invalidateToc();
        const lines = rows
          .slice(0, 40)
          .map((c) => `${c.op} ${c.path}${c.to ? ` → ${c.to}` : c.from ? ` ← ${c.from}` : ""}`);
        return text(
          `整理已落盘（${scopeLabel}）：版本 #${r.revision}，${params.ops.length} 个操作 / ${rows.length} 处变化。${
            params.summary ? `\n整理说明：${params.summary}` : ""
          }\n\n本版本变更（/memory changes 查看）：\n${lines.join("\n")}${
            rows.length > lines.length ? `\n…（另有 ${rows.length - lines.length} 处）` : ""
          }\n\n回滚：/memory rollback ${prevId ?? Number(r.revision) - 1}`,
        );
      } catch (e) {
        return text(`整理落盘失败（未改动）：${(e as Error).message}`);
      }
    },
  });

  gateTidyWrites(pi);

  pi.registerTool({
    name: "memory_diary",
    label: "日记",
    description:
      "查询某天的活动日记（读穿缓存：未缓存则返回当天原始素材并提示生成；已缓存则直接返回缓存内容并做陈旧检测）。日期省略=今天。",
    promptSnippet: "查某天的活动日记",
    promptGuidelines: [
      "Use memory_diary when the user asks what happened / what was done on a given date. If the tool returns raw material (cache miss), summarize it and persist with memory_write_note to the indicated path (日记/YYYY-MM-DD), keeping the watermark line intact — subsequent queries then hit the cache.",
    ],
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD；省略=今天" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { date?: string }) {
      const m = await memory();
      const local = new Date();
      const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
      const date = params.date?.trim() || today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return text(`日期格式应为 YYYY-MM-DD：${date}`);
      const path = `日记/${date}`;
      // 缓存命中：返回缓存内容 + 水位比对（之后又有新事件 → 标注陈旧）
      const sec = m.readSection(path);
      if (sec) {
        const body = sec.node.content || sec.node.leaves.join("\n");
        const wm = body.match(/素材水位[：:]\s*episodes?\s*≤\s*(\d+).*?revisions?\s*≤\s*(\d+)/);
        let stale = "";
        if (wm) {
          const d = m.dayDigest(date);
          if (d.watermark.maxEpisodeId > Number(wm[1]) || d.watermark.maxRevisionId > Number(wm[2]))
            stale = `\n\n⚠️ 缓存之后该日又有新事件（现水位 episodes ≤ ${d.watermark.maxEpisodeId} · revisions ≤ ${d.watermark.maxRevisionId}），如需最新可要求重建日记。`;
        }
        return text(`【缓存】${path}\n\n${body}${stale}`);
      }
      // 缓存未建：返回原始素材 + 生成指引；库启用前的历史日期兑底到叶子日期标记（弱视图）
      const d = m.dayDigest(date);
      if (d.empty) {
        const weak = m.leavesByDateMark(date);
        if (weak.length === 0) return text(`${date} 无记录（当天无 episodes、无写操作、无日期标记的叶子）。`);
        return text(
          [
            `【弱视图·素材未采集】${date}：当天无 episodes/写操作记录（库启用前），仅有叶子文本里带「← ${date}」标记的条目 ${weak.length} 条：`,
            "",
            ...weak.map((w) => `  · [${w.path}] ${w.leaf.slice(0, 100)}`),
            "",
            `→ 可据此写日记到 ${path}（无 session 维度，仅事实清单；末行附「> 素材水位：episodes ≤ 0 · revisions ≤ 0」）。`,
          ].join("\n"),
        );
      }
      const lines = [
        `【素材·未缓存】${date}`,
        "",
        ...d.sessions.map((s, i) => {
          const sid = s.sessionId ? s.sessionId.slice(0, 8) : "（无会话号）";
          const samples = s.userSamples.map((u) => `\n    · ${u}`).join("");
          return `Session ${i + 1}（${sid}…）：${s.events} 事件 · ${s.tools} 工具调用 · ${s.replies} 条回复\n    开场：${s.firstUser ?? "（无用户发言）"}${samples}`;
        }),
        "",
        "动过的节点（写入次数）：",
        ...d.nodes.map((n) => `  · ${n.path}（${n.ops}）`),
        "",
        `→ 请把当天活动总结成日记，用 memory_write_note 写入 ${path}：`,
        "   正文用 Markdown：每个 session 一句话主题 + 涉及的项目/节点路径（保持原路径以便交叉验证）；",
        `   末尾必须附一行「> 素材水位：episodes ≤ ${d.watermark.maxEpisodeId} · revisions ≤ ${d.watermark.maxRevisionId}」（缓存失效检测用）。`,
      ];
      return text(lines.join("\n"));
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
    // 跨 session 写入后：重载内存树 → 目录缓存失效（下一行重新生成）
    const m = await memory();
    if (m.reloadIfStale()) invalidateToc();
    // 采集：记住本轮用户 prompt，turn_end 时与助手/工具结果一起落 episodes
    if (CAPTURE_ON && event.messageType === "user" && typeof event.prompt === "string") {
      lastUserPrompt = event.prompt;
    }
    // 稳定段（目录+规则）：内容不变 → pi 差分为空 → 不重发不破缓存
    if (cachedToc === null) {
      cachedToc = tocDigest(m.root, { maxChars: SECTION_MAX_CHARS });
    }
    event.systemPromptOptions.sections.memory = [
      "长期记忆树目录（[n]=子树叶子总数，机器本地存储）：",
      cachedToc,
      "规则：需背景先 memory_read 下钻；不确定位置先 memory_search；出现跨会话价值的结论/决策/实体/待办时 memory_upsert 主动记（一条一事+日期）；若本轮使某条已有记忆过时/被取代，用 memory_update(path, match, leaf) 原地替换（match=被替换原文，须逐字一致且唯一），不要新增重复条；长正文（超一条叶子）用 memory_write_note 写成 Markdown；目录里的「：摘要」仅导航用，可用 memory_summary 刷新；结构性整理走 /memory tidy（受审的结构化操作）；勿猜路径。",
      `写入规范：${WRITE_STYLE}`,
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

  // ---------- 采集：每轮把用户/助手/工具结果落 episodes（P4 原始证据） ----------
  pi.on("turn_end", async (event: any, ctx: any) => {
    // 整理模式收尾：模型若未调用 memory_propose，解禁写工具（避免永久锁写）
    if (tidyMode) {
      tidyMode = false;
      tidyScope = null;
      ctx?.ui?.notify?.("整理模式已结束（写工具解禁）", "info");
    }
    if (!CAPTURE_ON) return undefined;
    try {
      const m = await memory();
      const seq = typeof event.turnIndex === "number" ? event.turnIndex : 0;
      const entries: Array<{ role: string; kind: string; text: string; toolName?: string | null; seq?: number }> = [];
      if (lastUserPrompt) {
        entries.push({ role: "user", kind: "user", text: clampEpisodeText(lastUserPrompt), seq });
        lastUserPrompt = null;
      }
      const atext = extractMessageText(event.message);
      if (atext) entries.push({ role: "assistant", kind: "assistant", text: clampEpisodeText(atext), seq });
      for (const r of event.toolResults ?? []) {
        const text = clampEpisodeText(
          extractMessageText(r?.content != null ? { content: r.content } : r) || safeJson(r),
        );
        if (text) entries.push({ role: "tool", kind: "tool_result", toolName: r?.toolName ?? r?.name ?? null, text, seq });
      }
      if (entries.length === 0) return undefined;
      let sessionId: string | null = null;
      try {
        sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
      } catch {
        sessionId = null;
      }
      m.captureEpisodes(sessionId, entries);
      // 仅在显式设了正数上限时才裁剪（0=永久保留；pruneEpisodes(0) 字面语义是全删，必须挡）
      if (EPISODE_MAX > 0 && m.countEpisodes() > EPISODE_MAX) m.pruneEpisodes(EPISODE_MAX);
    } catch {
      // 采集失败不阻断会话
    }
    return undefined;
  });

  // ---------- 命令 ----------

  /** 把变更行按版本归组：`#id op · detail` 头 + 缩进的逐条变更，便于挑版本回滚。 */
  const formatChangesByRevision = (changes: any[]): string => {
    const out: string[] = [];
    let cur = -1;
    for (const c of changes) {
      if (c.revisionId !== cur) {
        cur = c.revisionId;
        out.push(`${out.length ? "\n" : ""}#${c.revisionId} ${c.revOp}${c.revDetail ? ` · ${c.revDetail}` : ""}`);
      }
      out.push(
        `  ${c.op} ${c.path}${c.toText ? ` → ${c.toText.slice(0, 50)}` : c.fromText ? ` ← ${c.fromText.slice(0, 50)}` : ""}`,
      );
    }
    return out.join("\n");
  };

  pi.registerCommand("memory", {
    description: "Memory X：/memory 目录 | ui 只读浏览器视图 | tidy 整理（做梦）| lint 体检 | log 历史 | rollback <id> | commit 抽取 | changes 审计 | episodes 事件 | stats | dump",
    handler: async (args: string, ctx: any) => {
      const m = await memory();
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      if (tokens[0] === "ui") {
        const port = Number(tokens[1]) || Number(process.env.MEMORY_X_UI_PORT) || 7320;
        const url = `http://127.0.0.1:${port}`;
        const { exec } = await import("node:child_process");
        const openCmd =
          process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

        // 已在跑（可能是别的 session / 手动启动的独立进程）→ 直接打开
        if (await uiAlive(url)) {
          exec(`${openCmd} ${url}`, () => {});
          ctx.ui.notify(`UI 已在运行：${url}`, "info");
          return;
        }

        // 未运行 → 在独立终端里拉起 standalone 进程（独立于本 session；Ctrl-C 关闭该终端即停）
        const script = join(REPO_ROOT, "scripts", "ui.ts");
        const manual = `node ${script} --dir "${MEMORY_DIR}" --port ${port}`;
        const launched = await spawnUiInTerminal(
          [process.execPath, script, "--dir", MEMORY_DIR, "--port", String(port)],
          REPO_ROOT,
        );
        if (!launched) {
          ctx.ui.notify(`没能自动唤起终端。请在另一个终端手动执行：\n  ${manual}`, "warn");
        } else if (await waitUi(url, 5000)) {
          ctx.ui.notify(`已在独立终端启动只读 UI：${url}（Ctrl-C 关闭该终端即停；编辑请经 pi 会话）`, "info");
        } else {
          ctx.ui.notify(`终端已唤起，但 UI 尚未就绪。若未出现，请在另一终端手动执行：\n  ${manual}`, "warn");
        }
        return;
      }

      if (tokens[0] === "commit") {
        const sub = tokens[1];
        if (sub === "show" || sub === "log") {
          const changes = m.listChanges({ limit: Number(tokens[2]) || 30 });
          if (changes.length === 0) {
            ctx.ui.notify("暂无变更审计记录", "info");
            return;
          }
          ctx.ui.notify(
            `最近变更（${changes.length} 条，按版本）：\n${formatChangesByRevision(changes)}\n\n回滚某版本：/memory rollback <#id>`,
            "info",
          );
          return;
        }
        const recent = m.listEpisodes({ limit: 60 });
        if (recent.length === 0) {
          ctx.ui.notify("暂无可抽取的原始记录（本会话还没有对话）", "info");
          return;
        }
        const body = recent
          .map((e) => `#${e.id} [${e.role}/${e.kind}]${e.toolName ? `(${e.toolName})` : ""} ${e.text.slice(0, 400)}`)
          .join("\n");
        pi.sendMessage(
          {
            customType: "memory-commit",
            content: [
              "[提交任务] 从下面的原始会话记录中抽取值得长期记忆的内容，写入记忆树。",
              "规则：只抽取跨会话有价值的结论/决策/实体关系/待办/偏好；不臆造；一条一事；短句、主动语态、保留日期与专有名词（日期用今天）。",
              "新增用 memory_upsert；替换过时条目用 memory_update(path, match, leaf)。若某条结论明显来自某几条记录，用 memory_link_evidence(path, leaf, [episode ids]) 挂来源（推荐）。",
              "完成后用一句话说明写了什么（新增/替换了哪些）。",
              "",
              "原始记录（#id 为 episode id，可直接用作来源）：",
              body,
            ].join("\n"),
            display: true,
          },
          { triggerTurn: true },
        );
        ctx.ui.notify(`已发起抽取任务（${recent.length} 条原始记录）；完成后用 /memory changes 查看审计，或 /memory commit show`, "info");
        return;
      }

      if (tokens[0] === "changes") {
        const n = Number(tokens[1]) || 30;
        const changes = m.listChanges({ limit: n });
        if (changes.length === 0) {
          ctx.ui.notify("暂无变更审计记录", "info");
          return;
        }
        ctx.ui.notify(
          `最近变更（${changes.length} 条，按版本）：\n${formatChangesByRevision(changes)}\n\n回滚某版本：/memory rollback <#id>`,
          "info",
        );
        return;
      }

      if (tokens[0] === "episodes") {
        const n = Number(tokens[1]) || 20;
        const eps = m.listEpisodes({ limit: n });
        if (eps.length === 0) {
          ctx.ui.notify("暂无原始事件", "info");
          return;
        }
        const lines = eps.map((e) => `#${e.id} [${e.role}/${e.kind}] ${e.text.slice(0, 80)}`);
        ctx.ui.notify(`最近事件（共 ${m.countEpisodes()} 条）：\n${lines.join("\n")}`, "info");
        return;
      }

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
        const m = await memory();
        // 解析：/memory tidy [<路径>] [-- <指导语>]（" -- " 之后为注入整理 prompt 的自由文本）
        const after = args.trim().replace(/^tidy\b/, "").trim();
        let scopeArg = after;
        let hint: string | null = null;
        const sepIdx = after.indexOf(" -- ");
        if (sepIdx >= 0) {
          scopeArg = after.slice(0, sepIdx).trim();
          hint = after.slice(sepIdx + 4).trim() || null;
        } else if (after.startsWith("-- ")) {
          scopeArg = "";
          hint = after.slice(3).trim() || null;
        } else if (after === "--") {
          scopeArg = "";
        }
        if (scopeArg !== "") {
          // 显式节点路径 → 局部整理（模糊解析后取规范路径，保证结构化操作路径精确命中）
          const wantPath = scopeArg;
          const sec = m.readSection(wantPath);
          if (!sec) {
            const tops = m.root.children.map((c) => c.title).join("、") || "（空）";
            ctx.ui.notify(`节点不存在：${wantPath}\n当前顶层节点：${tops}`, "error");
            return;
          }
          const canonical = enumerateNodes(m.root).find((e) => e.node === sec.node)?.path ?? wantPath;
          await beginTidy(pi, m, ctx, canonical, hint);
          return;
        }

        // 无参 → 弹出树，选择范围（节点 = 局部整理；整棵树 = 全局整理）
        if (ctx.hasUI === false) {
          // print/json 模式无法交互：退回全局整理（保持旧行为）
          await beginTidy(pi, m, ctx, null, hint);
          return;
        }
        const entries = enumerateNodes(m.root);
        const picked = await ctx.ui.select("选择整理范围（节点＝局部整理，整棵树＝全局整理）：", [
          TIDY_GLOBAL_LABEL,
          ...entries.map((e) => e.label),
        ]);
        if (picked === undefined) {
          ctx.ui.notify("已取消整理", "info");
          return;
        }
        const scope = picked === TIDY_GLOBAL_LABEL ? null : entries.find((e) => e.label === picked)?.path ?? picked.trim();
        await beginTidy(pi, m, ctx, scope, hint);
        return;
      }

      if (tokens[0] === "log") {
        const n = Number(tokens[1] ?? 15);
        const revs = m.listRevisions(Number.isFinite(n) && n > 0 ? n : 15);
        if (revs.length === 0) {
          ctx.ui.notify("暂无版本历史", "info");
          return;
        }
        const lines = revs.map(
          (r) => `#${r.id} [${r.createdAt}] ${r.op}${r.path ? ` ${r.path}` : ""}${r.detail ? ` · ${r.detail}` : ""}`,
        );
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

// ---------- 整理（tidy）辅助 ----------

const TIDY_GLOBAL_LABEL = "整棵树（全局整理）";

interface NodeEntry {
  node: any;
  /** 物化规范路径（重名兄弟带 [n] 消歧）——与结构化操作路径精确匹配对齐 */
  path: string;
  label: string;
}

/** 枚举全树节点及其规范路径（含 [n] 消歧），供 picker 与路径规范化。复用 core 的 enumerateNodePaths。 */
function enumerateNodes(root: any): NodeEntry[] {
  const countLeaves = (n: any): number =>
    n.leaves.length + n.children.reduce((s: number, c: any) => s + countLeaves(c), 0);
  return enumerateNodePaths(root).map(({ node, path }) => {
    const total = countLeaves(node);
    return { node, path, label: `${path}${total > 0 ? ` [${total}]` : ""}` };
  });
}

/** 结构化操作的说明段（全局/局部整理共用）。 */
const OPS_GUIDE = [
  "输出方式：调用 memory_propose，参数 ops 是按序应用的操作数组。可用操作：",
  "  add_leaf{path,leaf} · update_leaf{path,match,leaf} · remove_leaf{path,match} · rename{path,title} · move{from,to} · add_node{parent,title} · delete{path} · set_note{path,content} · set_summary{path,summary}",
  "规则：path/from/to/parent 用物化规范路径（重名兄弟带 [n]）；match 必须是节点内**精确且唯一**的叶子原文；rename 同层不得重名；一条一事；时间戳保留。",
  "只做必要的改动——未在 ops 中提及的节点会原样保留，不会被重写。",
  "【禁止调用其它写工具（upsert/update/move/delete/…）——它们在整理模式下被拦截】。",
  "完成后调用 memory_propose 提交 ops（会**直接落盘**为一个版本，可 /memory rollback 回滚）+ 一句话整理说明；随后在回复里给出本版本变更摘要与回滚命令。",
];

/**
 * 发起整理：设置作用域与草稿状态，向模型投递 [整理任务]。
 * scope=null → 全局（整树）；否则 → 局部（限定在该子树内）。
 * hint 非空时作为「用户附加指导」拼进整理任务 prompt。
 */
async function beginTidy(pi: any, m: MemoryFile, ctx: any, scope: string | null, hint: string | null = null): Promise<void> {
  if (scope === null) {
    tidyMode = true;
    tidyScope = null;
    const lint = lintTree(m.root);
    pi.sendMessage(
      {
        customType: "memory-tidy",
        content: [
          "[整理任务] 请分析下面的记忆树，给出**结构化操作列表**（不要重写整棵树）。",
          "整理目标：合并重复/分散的事实；理顺层级与命名；精简冗长叶子（保留要点，不丢信息）；剔除明显过期内容。",
          ...(lint.length > 0
            ? [
                "结构体检发现以下问题，方案必须优先处理：",
                ...lint.map((i) => `- [${i.rule}] ${i.path || "(根)"}：${i.message}`),
              ]
            : []),
          ...OPS_GUIDE,
          ...(hint ? ["", "用户附加指导（请优先遵循）：", hint] : []),
          "",
          "当前记忆树全文（只读参考；改动请走 ops）：",
          "```",
          serializeMarkdown(m.root),
          "```",
        ].join("\n"),
        display: true,
      },
      { triggerTurn: true },
    );
    ctx.ui.notify(`全局整理任务已发起（做梦中…）${hint ? "，含附加指导" : ""}：模型将提出方案草稿，写工具已临时禁用`, "info");
    return;
  }

  const sec = m.readSection(scope);
  if (!sec) {
    ctx.ui.notify(`节点不存在：${scope}`, "error");
    return;
  }
  const node = sec.node;
  if (node.leaves.length === 0 && node.children.length === 0) {
    ctx.ui.notify(`节点「${scope}」没有叶子/子节点，无可整理的结构内容（content 不参与结构整理）`, "error");
    return;
  }
  tidyMode = true;
  tidyScope = scope;
  const lint = lintTree(m.root).filter((i) => i.path === scope || i.path.startsWith(`${scope}/`));
  pi.sendMessage(
    {
      customType: "memory-tidy",
      content: [
        `[整理任务] 请对记忆树中的节点「${scope}」做局部整理，给出**结构化操作列表**。`,
        "整理目标：合并重复/分散的事实；理顺层级与命名；精简冗长叶子（保留要点，不丢信息）；剔除明显过期内容。",
        ...(lint.length > 0
          ? [
              "结构体检发现以下问题，方案必须优先处理：",
              ...lint.map((i) => `- [${i.rule}] ${i.path}：${i.message}`),
            ]
          : []),
        "范围约束：",
        `- 只能改动该节点及其子树：所有 path / from / to / parent 必须以「${scope}」或其子路径开头。`,
        "- 该节点的 content（完整信息/RAG 语料）默认不要动（确有必要时才用 set_note）。",
        ...OPS_GUIDE,
        ...(hint ? ["", "用户附加指导（请优先遵循）：", hint] : []),
        "",
        `当前节点「${scope}」的内容（叶子 + 子节点，只读参考）：`,
        "```",
        serializeOutline(node),
        "```",
      ].join("\n"),
      display: true,
    },
    { triggerTurn: true },
  );
  ctx.ui.notify(`局部整理任务已发起：范围＝节点「${scope}」${hint ? "，含附加指导" : ""}，写工具已临时禁用`, "info");
}
