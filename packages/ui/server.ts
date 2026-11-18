/**
 * Memory X 只读 Web UI（零依赖：node:http + 单文件 HTML）。
 *
 * 设计约束：
 * - 只读——一切编辑经 Agent（pi 会话）进行，UI 不提供写路径
 * - server 是 core 之上的 JSON 薄壳；数据形状与 core 概念一一对应
 * - factory 注入 MemoryFile：扩展内复用同一实例（实时），
 *   独立运行时每次重开（跨进程新鲜度）
 * - 仅绑定 127.0.0.1
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFile, diffLines, diffStats, effectiveSummary, formatDiff, lintTree } from "../core/src/index.ts";
import { serializeMarkdown } from "../core/src/serializer.ts";
import { MemoryStore } from "../core/src/store.ts";
import type { MemoryNode } from "../core/src/types.ts";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "page.html");

export interface UiOptions {
  port?: number;
  host?: string;
}

export interface UiServer {
  server: Server;
  port: number;
  url: string;
}

interface NodeJson {
  title: string;
  path: string;
  summary: string;
  leafTotal: number;
  leafCount: number;
  hasContent: boolean;
  leaves: string[];
  content: string | null;
  children: NodeJson[];
}

export async function startUiServer(mfFactory: () => Promise<MemoryFile>, opts: UiOptions = {}): Promise<UiServer> {
  const port = opts.port ?? Number(process.env.MEMORY_X_UI_PORT ?? 7320);
  const host = opts.host ?? "127.0.0.1";

  const json = (res: any, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      const mf = await mfFactory();
      // 复用实例（pi 内嵌 /memory ui）时，另一个 session 可能已写入：应答前按 DB 版本号重载
      mf.reloadIfStale();

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await readFile(PAGE, "utf8"));
        return;
      }
      if (url.pathname === "/api/tree") {
        return json(res, 200, { tree: toJson(mf.root) });
      }
      if (url.pathname === "/api/stats") {
        return json(res, 200, { ...collect(mf.root), dir: mf.dir });
      }
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const scope = url.searchParams.get("scope") ?? undefined;
        return json(res, 200, { hits: q ? mf.search(q, 10, scope) : [] });
      }
      if (url.pathname === "/api/lint") {
        return json(res, 200, { issues: lintTree(mf.root) });
      }
      if (url.pathname === "/api/revisions") {
        return json(res, 200, { revisions: mf.listRevisions(Number(url.searchParams.get("limit") ?? 100)) });
      }
      if (url.pathname === "/api/revisions/diff") {
        const id = Number(url.searchParams.get("id"));
        const store = MemoryStore.open(mf.dir);
        try {
          const cur = await revisionMarkdown(store, id);
          const prev = await revisionMarkdown(store, id - 1);
          const diff = diffLines(prev.split("\n"), cur.split("\n"));
          return json(res, 200, { id, ...diffStats(diff), diff: formatDiff(diff, 400) });
        } finally {
          store.close();
        }
      }
      if (url.pathname === "/api/ping") {
        return json(res, 200, { latest: mf.listRevisions(1)[0]?.id ?? 0 });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as { port: number }).port;
  return { server, port: actualPort, url: `http://${host}:${actualPort}` };
}

/** 物化路径（含 [n] 消歧）的树 JSON——与 store.saveTree 同一套消歧规则 */
function toJson(root: MemoryNode): NodeJson[] {
  const countLeaves = (n: MemoryNode): number =>
    n.leaves.length + n.children.reduce((s, c) => s + countLeaves(c), 0);
  const walk = (n: MemoryNode, path: string): NodeJson => {
    const counts = new Map<string, number>();
    return {
      title: n.title,
      path,
      summary: effectiveSummary(n, { childTitles: false }),
      leafTotal: countLeaves(n),
      leafCount: n.leaves.length,
      hasContent: n.content != null,
      leaves: n.leaves,
      content: n.content ?? null,
      children: n.children.map((c) => {
        const seen = (counts.get(c.title) ?? 0) + 1;
        counts.set(c.title, seen);
        const seg = seen > 1 ? `${c.title}[${seen}]` : c.title;
        return walk(c, path === "" ? seg : `${path}/${seg}`);
      }),
    };
  };
  const topCounts = new Map<string, number>();
  return root.children.map((c) => {
    const seen = (topCounts.get(c.title) ?? 0) + 1;
    topCounts.set(c.title, seen);
    const seg = seen > 1 ? `${c.title}[${seen}]` : c.title;
    return walk(c, seg);
  });
}

async function revisionMarkdown(store: MemoryStore, id: number): Promise<string> {
  if (id < 1) return "# Memory\n";
  const tree = store.materializeTree(id);
  return tree ? serializeMarkdown(tree) : "# Memory\n";
}

function collect(root: MemoryNode): { nodes: number; leaves: number; depth: number } {
  let nodes = 0;
  let leaves = 0;
  let depth = 0;
  const walk = (n: MemoryNode, d: number) => {
    nodes++;
    leaves += n.leaves.length;
    depth = Math.max(depth, d);
    for (const c of n.children) walk(c, d + 1);
  };
  for (const c of root.children) walk(c, 1);
  return { nodes, leaves, depth };
}
