import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../src/memory-file.ts";
import { startUiServer } from "../../ui/server.ts";

async function seededServer() {
  const dir = await mkdtemp(join(tmpdir(), "mx-ui-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/pi调研", "RPC 与 SDK 共享 core 层");
  await mf.upsertNode("生活/健康", "每周三体检");
  const { server, port, url } = await startUiServer(() => MemoryFile.open(dir), { port: 0 });
  return { dir, mf, server, port, url };
}

test("UI server：页面与各 API 端点", async () => {
  const { server, port, url } = await seededServer();

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Memory X/);

  const tree = (await (await fetch(`${url}/api/tree`)).json()).tree;
  assert.equal(tree[0].title, "工作");
  assert.equal(tree[0].children[0].path, "工作/pi调研");
  assert.deepEqual(tree[0].children[0].leaves, ["RPC 与 SDK 共享 core 层"]);

  const hits = (await (await fetch(`${url}/api/search?q=${encodeURIComponent("体检")}`)).json()).hits;
  assert.equal(hits[0].path, "生活/健康");

  const revs = (await (await fetch(`${url}/api/revisions`)).json()).revisions;
  assert.equal(revs.length, 2);
  assert.equal(revs[0].op, "upsert");

  const diff = await (await fetch(`${url}/api/revisions/diff?id=2`)).json();
  assert.ok(typeof diff.added === "number");
  assert.match(diff.diff, /体检|生活|健康/);

  const lint = (await (await fetch(`${url}/api/lint`)).json()).issues;
  assert.ok(Array.isArray(lint));

  const ping = await (await fetch(`${url}/api/ping`)).json();
  assert.equal(ping.latest, 2);

  assert.equal((await fetch(`${url}/api/nope`)).status, 404);

  server.close();
  server.closeAllConnections();
});

test("UI server：跨进程写入后新鲜度（factory 每次重开）", async () => {
  const { dir, server, url } = await seededServer();
  // 模拟另一进程写入
  const other = await MemoryFile.open(dir);
  await other.upsertNode("新域", "新事实");

  const tree = (await (await fetch(`${url}/api/tree`)).json()).tree;
  assert.ok(tree.some((n: any) => n.title === "新域"));
  server.close();
  server.closeAllConnections();
});
