// 独立启动只读 Web UI：memory-x ui [--dir <记忆目录>] [--port <端口>] [--host <地址>] [--no-open]
//
// - 前台运行，Ctrl-C 退出（不做 daemon / pidfile）
// - 端口已有 UI 在跑时直接复用：打开浏览器并退出（避免 EADDRINUSE）
// - 每次请求重开 MemoryFile：与其它进程/session 共享同一 DB 时保持新鲜
import { MemoryFile } from "../packages/core/src/memory-file.ts";
import { startUiServer } from "../packages/ui/server.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const dir = arg("dir") ?? process.env.MEMORY_X_DIR ?? join(homedir(), "memory-x", "memory");
const host = arg("host") ?? "127.0.0.1";
const envPort = process.env.MEMORY_X_UI_PORT ? Number(process.env.MEMORY_X_UI_PORT) : undefined;
const port = arg("port") ? Number(arg("port")) : (envPort ?? 7320);
const noOpen = flag("no-open");

const openCmd =
  process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
const openBrowser = (url: string) => {
  if (!noOpen) exec(`${openCmd} ${url}`, () => {});
};

// 单实例：端口已有响应则复用它，不再新起进程
const existing = await probeUi(host, port);
if (existing) {
  console.log(`Memory X UI 已在运行：${existing}（需重启请先在该终端 Ctrl-C）`);
  openBrowser(existing);
  process.exit(0);
}

const { url } = await startUiServer(() => MemoryFile.open(dir), { port, host });
console.log(`Memory X UI: ${url}  （${dir}）`);
console.log("Ctrl-C 退出");
openBrowser(url);

async function probeUi(h: string, p: number): Promise<string | null> {
  const url = `http://${h}:${p}`;
  try {
    const res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(800) });
    if (res.ok) return url;
  } catch {
    // 端口上没有在跑的 UI
  }
  return null;
}
