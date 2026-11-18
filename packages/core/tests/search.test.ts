import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryFile } from "../src/memory-file.ts";

async function seeded(): Promise<{ dir: string; mf: MemoryFile }> {
  const dir = await mkdtemp(join(tmpdir(), "mx-search-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/pi生态调研", "RPC 模式与 SDK 模式是兄弟关系");
  await mf.upsertNode("工作/pi生态调研", "pi-web 用 SDK 进程内嵌入");
  await mf.writeNote(
    "工作/pi生态调研",
    "完整调研正文：包含 SQLite 镜像方案与崩溃窗口分析，信源为官方文档。",
  );
  await mf.upsertNode("生活/健康", "每周三体检提醒");
  return { dir, mf };
}

test("FTS 命中：≥3 字词走 trigram（bm25+snippet），返回完整链路/祖先/兄弟", async () => {
  const { mf } = await seeded();
  const hits = mf.search("生态调研"); // 4 字 → trigram
  assert.equal(hits.length, 1);
  const h = hits[0]!;
  assert.equal(h.path, "工作/pi生态调研");
  assert.deepEqual(h.ancestors, ["工作"]);
  assert.ok(h.siblings.includes("pi生态调研"), "兄弟应含自身（同层节点）");
  assert.equal(h.hasContent, true);
  assert.equal(h.leafCount, 2);
  assert.equal(h.via, "fts");
});

test("中文双字词（trigram 不可用）自动落 LIKE 兜底", async () => {
  const { mf } = await seeded();
  const hits = mf.search("调研"); // 2 字
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.path, "工作/pi生态调研");
  assert.equal(hits[0]!.via, "like");
});

test("content 正文命中（RAG 语料）", async () => {
  const { mf } = await seeded();
  const hits = mf.search("崩溃窗口");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.path, "工作/pi生态调研");
  assert.match(hits[0]!.snippet, /崩溃窗口|…/);
});

test("LIKE 兜底：2 字短词（trigram 无法命中）", async () => {
  const { mf } = await seeded();
  const hits = mf.search("体检");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.path, "生活/健康");
  assert.equal(hits[0]!.via, "like");
});

test("CJK 长词滑窗拆分：整句可命中包含其片段的文档", async () => {
  const { mf } = await seeded();
  // 整句作为子串匹配不到；滑窗 trigram 后应命中含「镜像方案」的 content
  const hits = mf.search("镜像方案的细节是什么");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.path, "工作/pi生态调研");
});

test("无命中返回空；topK 生效", async () => {
  const { mf } = await seeded();
  assert.equal(mf.search("完全不存在的词汇xyzq").length, 0);
  const all = mf.search("调研 pi", 1);
  assert.ok(all.length <= 1);
});

test("访问信号：search/read 记录 hits 与 last_hit", async () => {
  const { dir, mf } = await seeded();
  mf.search("调研");
  mf.recordAccess("工作/pi生态调研");
  const db = new DatabaseSync(join(dir, ".memory", "memory.db"), { readOnly: true });
  const row = db
    .prepare("SELECT hits FROM access WHERE path = ?")
    .get("工作/pi生态调研") as { hits: number } | undefined;
  assert.ok(row);
  assert.ok(row!.hits >= 2);
});

test("旧库（无 FTS 数据）打开时自动补建索引", async () => {
  const { dir } = await seeded();
  // 模拟旧库：清空 FTS
  const db = new DatabaseSync(join(dir, ".memory", "memory.db"));
  db.exec("DELETE FROM memory_fts");
  db.close();

  const mf2 = await MemoryFile.open(dir);
  const hits = mf2.search("调研");
  assert.equal(hits.length, 1);
});

test("停用词：纯虚词查询返回空，不进 LIKE 兜底", async () => {
  const { mf } = await seeded();
  assert.equal(mf.search("什么 怎么").length, 0);
  assert.equal(mf.search("帮我看看").length, 0);
  assert.equal(mf.search("the a of").length, 0);
});

test("信号加成：高频访问的节点排序上升", async () => {
  const dir = (await seeded()).dir;
  const mf = await MemoryFile.open(dir);
  // 两个节点都含「调研」，给 工作方向 大量访问信号
  await mf.upsertNode("工作方向", "主题：儿童识字调研");
  for (let i = 0; i < 10; i++) mf.recordAccess("工作方向");
  const hits = mf.search("调研");
  assert.ok(hits.length >= 2);
  assert.equal(hits[0]!.path, "工作方向", "访问频次应提升排序");
  assert.ok(hits[0]!.score > hits[1]!.score);
});

test("SearchHit 携带 score 字段", async () => {
  const { mf } = await seeded();
  const h = mf.search("生态调研")[0]!;
  assert.ok(typeof h.score === "number" && h.score > 0);
});

test("写入后索引自动刷新（新内容可搜）", async () => {
  const { mf } = await seeded();
  await mf.upsertNode("项目/新项目", "火山引擎函数计算调研");
  const hits = mf.search("函数计算");
  assert.equal(hits[0]!.path, "项目/新项目");
});
