import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../src/memory-file.ts";

async function fresh(): Promise<MemoryFile> {
  const dir = await mkdtemp(join(tmpdir(), "mx-update-"));
  return MemoryFile.open(dir);
}

test("updateNode：唯一命中则原地替换（旧值消失、新值出现、记版本）", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/prefs", "数据库用 SQLite");
  await mf.upsertNode("工作/prefs", "给他起名叫 Bob");
  const r = await mf.updateNode("工作/prefs", "数据库用 SQLite", "数据库用 Postgres ← 2026-11-18");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(String(r.revision), /.+/);
  const leaves = mf.readSection("工作/prefs")!.node.leaves;
  assert.ok(leaves.includes("数据库用 Postgres ← 2026-11-18"));
  assert.ok(!leaves.includes("数据库用 SQLite"), "旧值应被替换掉");
  assert.ok(leaves.includes("给他起名叫 Bob"), "无关叶子不动");
});

test("updateNode：match 未命中则不改动（ok=false）", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/prefs", "数据库用 SQLite");
  const r = await mf.updateNode("工作/prefs", "数据库用 MySQL", "数据库用 Postgres");
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.deepEqual(mf.readSection("工作/prefs")!.node.leaves, ["数据库用 SQLite"]);
});

test("updateNode：不动节点 content", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/调研", "阶段=进行中");
  await mf.writeNote("工作/调研", "# 调研正文\n不参与叶子替换");
  await mf.updateNode("工作/调研", "阶段=进行中", "阶段=已完成");
  assert.equal(mf.readNote("工作/调研"), "# 调研正文\n不参与叶子替换");
  assert.deepEqual(mf.readSection("工作/调研")!.node.leaves, ["阶段=已完成"]);
});
