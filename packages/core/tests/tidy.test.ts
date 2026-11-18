import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffStats, formatDiff } from "../src/diff.ts";
import { MemoryFile } from "../src/memory-file.ts";
import { serializeMarkdown } from "../src/serializer.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("diffLines：增删改识别", () => {
  const a = ["# Memory", "", "## 工作", "- 事实A", "- 事实B"];
  const b = ["# Memory", "", "## 工作", "- 事实A", "- 事实B2", "", "## 生活", "- 体检"];
  const diff = diffLines(a, b);
  const s = diffStats(diff);
  assert.equal(s.added, 4); // 事实B2 + 空行 + 生活 + 体检
  assert.equal(s.removed, 1); // 事实B
  const out = formatDiff(diff);
  assert.match(out, /- - 事实B/);
  assert.match(out, /\+ - 事实B2/);
  assert.match(out, /\+ ## 生活/);
});

test("diffStats：相同内容零变更", () => {
  const same = ["a", "b"];
  assert.deepEqual(diffStats(diffLines(same, [...same])), { added: 0, removed: 0 });
});

test("applyTree：整树替换 + 记 tidy 版本 + 可回滚", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-tidy-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/调研", "事实A");
  await mf.upsertNode("工作/调研", "事实B");
  await mf.upsertNode("生活", "体检");
  const beforeRev = Number(mf.listRevisions(1)[0]!.id);

  const r = await mf.applyTree("## 工作\n- 事实A（合并）\n\n## 生活\n- 体检\n");
  assert.equal(r.ok, true);
  assert.match(String(r.revision), /.+/);
  assert.equal(mf.root.children.length, 2);
  assert.deepEqual(mf.readSection("工作")!.node.leaves, ["事实A（合并）"]);

  const log = mf.listRevisions(1)[0]!;
  assert.equal(log.op, "tidy");

  // 回滚到整理前
  await mf.restoreRevision(beforeRev);
  assert.deepEqual(mf.readSection("工作/调研")!.node.leaves, ["事实A", "事实B"]);
  assert.equal(serializeMarkdown(mf.root).includes("事实A（合并）"), false);
});

test("applyTree：根下带列表项拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-tidy2-"));
  const mf = await MemoryFile.open(dir);
  await assert.rejects(() => mf.applyTree("- 不允许\n## 域\n"), /根节点下不应有列表项/);
});
