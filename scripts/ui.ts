// 独立启动：node scripts/ui.ts [--dir <记忆目录>] [--port <端口>]
// （pi 会话内请用 /memory ui —— 复用扩展的实时实例）
import { MemoryFile } from "../packages/core/src/memory-file.ts";
import { startUiServer } from "../packages/ui/server.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("dir") ?? process.env.MEMORY_X_DIR ?? join(homedir(), "memory-x", "memory");
const port = arg("port") ? Number(arg("port")) : undefined;

// 每次请求重开实例：pi 在别的进程写入时保持新鲜
const { url } = await startUiServer(() => MemoryFile.open(dir), { port });
console.log(`Memory X UI: ${url}  （${dir}）`);

const openCmd =
  process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
exec(`${openCmd} ${url}`, () => {});
