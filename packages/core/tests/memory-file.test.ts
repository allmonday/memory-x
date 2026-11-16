import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MemoryFile } from "../src/memory-file.ts";

function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-x-"));
}

test("MemoryFile 全链路：upsert → 原子写 → git 快照", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);

  // 新建（MEMORY.md 不存在）→ 空树
  assert.equal(mf.root.children.length, 0);

  const r1 = await mf.upsertNode("工作/pi生态调研", "RPC 与 SDK 共享 core 层");
  assert.equal(r1.ok, true);
  assert.ok(r1.revision, "应产生 git commit");

  // 落盘内容可解析、与内存一致
  const onDisk = await readFile(join(dir, "MEMORY.md"), "utf8");
  assert.match(onDisk, /### pi生态调研/);
  assert.match(onDisk, /- RPC 与 SDK 共享 core 层/);

  // 幂等：同条目重复写不产生新 commit
  const r2 = await mf.upsertNode("工作/pi生态调研", "RPC 与 SDK 共享 core 层");
  assert.equal(r2.changed, false);
  assert.equal(r2.revision, null);

  // move + delete
  await mf.upsertNode("归档", "旧结论");
  const r3 = await mf.moveNode("工作/pi生态调研", "归档");
  assert.equal(r3.ok, true);
  const r4 = await mf.deleteNode("归档/pi生态调研");
  assert.equal(r4.ok, true);

  // git 历史可回溯
  const log = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
  assert.match(log, /memory: upsert/);
  assert.match(log, /memory: move/);
  assert.match(log, /memory: delete/);

  // 重新打开：状态从盘恢复
  const mf2 = await MemoryFile.open(dir);
  assert.equal(mf2.root.children[0]!.title, "工作");
  assert.equal(mf2.root.children[0]!.children.length, 0);
});

test("MemoryFile 拒绝解析损坏的既有文件", async () => {
  const dir = await tmpDir();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "MEMORY.md"), "这不是合法文档\n", "utf8");
  await assert.rejects(() => MemoryFile.open(dir), /第 1 行/);
});
