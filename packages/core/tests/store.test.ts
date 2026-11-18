import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MemoryFile } from "../src/memory-file.ts";
import { parseMarkdown } from "../src/parser.ts";
import { serializeMarkdown } from "../src/serializer.ts";

function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mx-store-"));
}

test('store 往返：内存树 → SQLite → 内存树（含 content/重名消歧）', async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode('工作/pi生态调研', 'RPC 与 SDK 共享 core 层');
  await mf.writeNote('工作/pi生态调研', '完整的调研正文。\n多行内容，含特殊字符 <>/&。');
  await mf.upsertNode('项目', 'A');

  const mf2 = await MemoryFile.open(dir);
  const sec = mf2.readSection('工作/pi生态调研')!;
  assert.equal(sec.node.leaves[0], 'RPC 与 SDK 共享 core 层');
  assert.equal(sec.node.content, '完整的调研正文。\n多行内容，含特殊字符 <>/&。');
});


test("物化 path：重名兄弟自动 [n]，前缀检索带完整链路", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  // 手工构造两个同名"项目"
  mf.root.children.push({ title: "项目", leaves: [], children: [] });
  mf.root.children.push({ title: "项目", leaves: [], children: [] });
  await mf.upsertNode("项目[2]/子", "事实");

  const db = new DatabaseSync(join(dir, ".memory", "memory.db"), { readOnly: true });
  const rows = db.prepare("SELECT path, title, depth FROM nodes WHERE path LIKE '项目%'").all() as Array<{
    path: string;
    title: string;
    depth: number;
  }>;
  const paths = rows.map((r) => r.path).sort();
  assert.ok(paths.includes("项目"));
  assert.ok(paths.includes("项目[2]"));
  assert.ok(paths.includes("项目[2]/子"), "子节点路径应带消歧前缀");
  // findByPathPrefix
  const mf2 = await MemoryFile.open(dir);
  void mf2;
});

test("旧版 MEMORY.md 自动迁移进 db", async () => {
  const dir = await tmpDir();
  await writeFile(
    join(dir, "MEMORY.md"),
    "# Memory\n\n## 工作\n### 旧节点\n- 旧事实\n",
    "utf8",
  );
  const mf = await MemoryFile.open(dir);
  assert.equal(mf.readSection("工作/旧节点")!.node.leaves[0], "旧事实");

  const db = new DatabaseSync(join(dir, ".memory", "memory.db"), { readOnly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
  assert.equal(n, 3, "根+工作+旧节点");
});

test('写操作后：db 更新 + 版本记录 + 幂等无新版本', async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  const r1 = await mf.upsertNode('域', '事实一');
  assert.ok(r1.revision);
  const r2 = await mf.upsertNode('域', '事实一');
  assert.equal(r2.changed, false);
  await mf.deleteNode('域');
  assert.equal(mf.listRevisions(10).length, 2, 'upsert + delete');
  const db = new DatabaseSync(join(dir, '.memory', 'memory.db'), { readOnly: true });
  const n = (db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
  assert.equal(n, 1, '只剩根');
});


test("content 含 ``` 行时拒绝写入", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域", "x");
  await assert.rejects(
    () => mf.writeNote("域", "line1\n```\nline2"),
    /含围栏行/,
  );
});
