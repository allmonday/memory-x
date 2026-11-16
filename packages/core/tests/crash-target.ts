// 崩溃安全验证：循环写入中 SIGKILL，验证 MEMORY.md 始终可解析（原子性 DoD）
import { MemoryFile } from "../src/memory-file.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "memory-x-crash-"));
const marker = process.argv[2] ?? "run";
const mf = await MemoryFile.open(dir);
for (let i = 0; i < 500; i++) {
  await mf.upsertNode(`域${i % 5}/节点${i}`, `事实 ${marker}-${i}`);
}
console.log("done", dir);
