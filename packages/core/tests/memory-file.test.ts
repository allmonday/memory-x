import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../src/memory-file.ts";

function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-x-"));
}

test('MemoryFile 全链路：upsert → 版本记录 → 重开恢复', async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  assert.equal(mf.root.children.length, 0);
  const r1 = await mf.upsertNode('工作/pi生态调研', 'RPC 与 SDK 共享 core 层');
  assert.equal(r1.ok, true);
  assert.ok(r1.revision, '应产生版本号');
  const r2 = await mf.upsertNode('工作/pi生态调研', 'RPC 与 SDK 共享 core 层');
  assert.equal(r2.changed, false);
  await mf.upsertNode('归档', '旧结论');
  await mf.moveNode('工作/pi生态调研', '归档');
  await mf.deleteNode('归档/pi生态调研');
  const log = mf.listRevisions(10);
  assert.equal(log.length, 4, 'upsert×2 + move + delete');
  assert.equal(log[0]!.op, 'delete');
  const mf2 = await MemoryFile.open(dir);
  assert.equal(mf2.root.children[0]!.title, '工作');
  assert.equal(mf2.root.children[0]!.children.length, 0);
});


test("MemoryFile 拒绝解析损坏的既有文件", async () => {
  const dir = await tmpDir();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "MEMORY.md"), "这不是合法文档\n", "utf8");
  await assert.rejects(() => MemoryFile.open(dir), /第 1 行/);
});
