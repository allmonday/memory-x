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

test("applyOutline：局部整理按路径保留子节点 content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-tidy-local-content-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/调研", "事实A");
  await mf.writeNote("工作/调研", "调研完整正文");
  await mf.upsertNode("工作/调研", "事实B");
  await mf.upsertNode("生活", "体检");

  // 同路径子节点（叶子被重写）content 应保留，且不误伤兄弟域
  await mf.applyOutline("工作", "### 调研\n- 事实A（合并）\n");
  assert.equal(mf.readNote("工作/调研"), "调研完整正文");
  assert.deepEqual(mf.readSection("工作/调研")!.node.leaves, ["事实A（合并）"]);
  assert.equal(mf.readNote("生活"), null);

  // 重新从 DB 打开，确认 content 确已落盘（而非仅内存保留）
  const reopened = await MemoryFile.open(dir);
  assert.equal(reopened.readNote("工作/调研"), "调研完整正文");

  // 改名/路径变化的子节点无法映射，content 丢失（明确记录该行为）
  await mf.applyOutline("工作", "### 调研改名\n- 事实A（合并）\n");
  assert.equal(mf.readNote("工作/调研改名"), null);
});

test("applyTree：按路径保留节点 content（整树整理不丢完整信息）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-tidy-content-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/调研", "事实A");
  await mf.writeNote("工作/调研", "调研完整正文");
  await mf.upsertNode("生活", "体检");

  // 同路径节点（即使叶子被重写）content 应保留
  await mf.applyTree("## 工作\n### 调研\n- 事实A（合并）\n\n## 生活\n- 体检\n");
  assert.equal(mf.readNote("工作/调研"), "调研完整正文");
  assert.deepEqual(mf.readSection("工作/调研")!.node.leaves, ["事实A（合并）"]);

  // 改名/路径变化的节点无法映射，content 丢失（明确记录该行为）
  await mf.applyTree("## 工作\n### 调研改名\n- 事实A（合并）\n\n## 生活\n- 体检\n");
  assert.equal(mf.readNote("工作/调研改名"), null);
});
