#!/usr/bin/env node
// Memory X 命令行入口：memory-x <command>
// 目前仅 ui：在独立进程/终端中启动只读 Web UI（前台运行，Ctrl-C 退出）。
// 安装为全局命令：npm link（在仓库根）或 npm i -g .，之后任意目录可用 memory-x ui。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Memory X CLI

用法：memory-x <command> [options]

命令：
  ui        启动只读 Web UI（独立进程；前台运行，Ctrl-C 退出）
  help      显示本帮助

ui 选项：
  --dir <path>    记忆目录（默认 $MEMORY_X_DIR 或 ~/memory-x/memory）
  --port <n>      端口（默认 $MEMORY_X_UI_PORT 或 7320）
  --host <ip>     绑定地址（默认 127.0.0.1）
  --no-open       不自动打开浏览器

示例：
  memory-x ui
  memory-x ui --port 7330 --dir ~/memory-x/memory
`;

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  process.stdout.write(HELP);
  process.exit(0);
}

if (cmd === "ui") {
  const script = join(repo, "scripts", "ui.ts");
  const child = spawn(process.execPath, [script, ...rest], { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(signal ? 130 : code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
} else {
  process.stderr.write(`未知命令：${cmd}\n\n${HELP}`);
  process.exit(1);
}
