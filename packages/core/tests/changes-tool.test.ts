import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatChangesForModel } from "../../pi-extension/index.ts";
import { MemoryFile } from "../src/memory-file.ts";

function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mx-changes-tool-"));
}

test("formatChangesForModel：按版本归组，头带时间戳，from→to 成对", () => {
  const out = formatChangesForModel([
    {
      revisionId: 42,
      revOp: "update",
      revDetail: "替换叶子",
      op: "remove",
      path: "工作/项目A",
      fromText: "初版结论",
      toText: null,
      createdAt: "2026-11-21 14:32:10",
    },
    {
      revisionId: 42,
      revOp: "update",
      revDetail: "替换叶子",
      op: "add",
      path: "工作/项目A",
      fromText: null,
      toText: "修订后结论",
      createdAt: "2026-11-21 14:32:10",
    },
    {
      revisionId: 41,
      revOp: "upsert",
      revDetail: null,
      op: "add",
      path: "工作/项目A",
      fromText: null,
      toText: "初版结论",
      createdAt: "2026-11-21 14:30:00",
    },
  ]);
  const lines = out.split("\n");
  assert.equal(lines[0], "#42 2026-11-21 14:32:10 update · 替换叶子");
  assert.equal(lines[1], "   - remove 工作/项目A：初版结论");
  assert.equal(lines[2], "   - add 工作/项目A：修订后结论");
  assert.ok(lines[3] === "", "版本之间空行分隔");
  assert.equal(lines[4], "#41 2026-11-21 14:30:00 upsert");
});

test("formatChangesForModel：超长 from/to 截断", () => {
  const long = "很".repeat(100);
  const out = formatChangesForModel([
    {
      revisionId: 1,
      revOp: "update",
      revDetail: null,
      op: "remove",
      path: "域",
      fromText: long,
      toText: null,
      createdAt: "2026-11-21 00:00:00",
    },
  ]);
  assert.ok(out.includes("…"), "应截断标注");
  assert.ok(!out.includes(long), "不应包含全文");
});

test("listChanges → formatChangesForModel：真实写入链路端到端", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("域", "旧事实");
  await mf.updateNode("域", "旧事实", "新事实");

  const rows = mf.listChanges({ limit: 20 });
  const out = formatChangesForModel(rows);
  // 新→旧：第一行是更晚的版本
  const firstRev = Number(out.split("\n")[0]!.match(/^#(\d+)/)![1]);
  const lastRev = Number(out.split("\n").filter((l) => l.startsWith("#")).pop()!.match(/^#(\d+)/)![1]);
  assert.ok(firstRev > lastRev, "版本头应新→旧");
  assert.ok(out.includes("旧事实"), "审计视角保留旧值（from）");
  assert.ok(out.includes("新事实"), "新值也在");
});
