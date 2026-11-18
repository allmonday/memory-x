// 崩溃安全验证（WAL 事务）：循环写入中 SIGKILL，验证 db 完好可打开
// 用法：npm run crash-verify
import { MemoryFile } from "../packages/core/src/memory-file.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "memory-x-crash-"));
const mf = await MemoryFile.open(dir);
for (let i = 0; i < 500; i++) {
  await mf.upsertNode(`域${i % 5}/节点${i}`, `事实 ${i}`);
  // 留窗口给外部 kill：写到一半被杀是本脚本的目标场景
  if (i % 10 === 0) await new Promise((r) => setTimeout(r, 5));
}
console.log("done", dir);
