import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorGuards } from "../../pi-extension/index.ts";
import { MemoryFile } from "../src/memory-file.ts";

async function file(): Promise<MemoryFile> {
  const dir = await mkdtemp(join(tmpdir(), "mx-anchor-"));
  return MemoryFile.open(dir);
}

test("写入门禁：写已存在但未读的节点 → 提示；strict → 阻断", async () => {
  const mf = await file();
  await mf.upsertNode("工作/项目A", "既有事实");

  const hint = anchorGuards(mf, "工作/项目A", new Set(), { strict: false });
  assert.equal(hint.block, false);
  assert.ok(hint.hints.some((h) => h.includes("未 memory_read")), "hint 模式应提示先读");

  const strict = anchorGuards(mf, "工作/项目A", new Set(), { strict: true });
  assert.equal(strict.block, true, "strict 模式应阻断");
  assert.ok(strict.hints.some((h) => h.includes("⛔")));

  const read = anchorGuards(mf, "工作/项目A", new Set(["工作/项目A"]), { strict: true });
  assert.equal(read.block, false, "本会话已读过则放行");
});

test("写入门禁：新路径（节点不存在）不触发", async () => {
  const mf = await file();
  await mf.upsertNode("工作/项目A", "既有事实");
  const g = anchorGuards(mf, "工作/全新节点", new Set(), { strict: true });
  assert.equal(g.block, false, "新节点无「先读」义务（虚锚惰性物化）");
  assert.ok(!g.hints.some((h) => h.includes("未 memory_read")));
});

test("查重探针：同主题命中在目标子树之外 → 提示原地替换", async () => {
  const mf = await file();
  await mf.upsertNode("工作/项目A", "项目A 的当前状态是进行中，主要阻力在依赖审批流程未走完");
  await mf.upsertNode("生活/杂记", "今天天气不错适合出门散步"); // 第二文档使 IDF 非零（单文档 bm05 全为 0）
  // 向「工作/新主题」写入与「项目A」叶子高度相似的内容（长度接近真实叶子，bm25 才够分）
  const g = anchorGuards(mf, "工作/新主题", new Set(), {
    probeQuery: "项目A 的当前状态是进行中，主要阻力在依赖审批流程未走完",
  });
  assert.ok(
    g.hints.some((h) => h.includes("工作/项目A") && h.includes("memory_update")),
    "应提示疑似同主题并建议 update",
  );
});

test("查重探针：命中就在目标子树内 → 不提示", async () => {
  const mf = await file();
  await mf.upsertNode("工作/项目A", "项目A 的当前状态是进行中，主要阻力在依赖审批流程未走完");
  await mf.upsertNode("生活/杂记", "今天天气不错适合出门散步");
  await mf.upsertNode("工作/项目A", "补充细节：审批责任人已换成王工");
  const g = anchorGuards(mf, "工作/项目A", new Set(["工作/项目A"]), {
    probeQuery: "项目A 的当前状态是进行中，主要阻力在依赖审批流程未走完",
  });
  assert.ok(!g.hints.some((h) => h.includes("疑似同主题")), "目标子树内的命中不算越界");
});

test("查重探针：无相似内容/阈值以下 → 不提示（minScore 可调）", async () => {
  const mf = await file();
  await mf.upsertNode("工作/项目A", "nexusx 当前 v6.8.0；近期主题：MCP tool annotations 加 mutation 确认逻辑已完成");
  const g = anchorGuards(mf, "生活/新主题", new Set(), { probeQuery: "今天午饭吃了什么", minScore: 999 });
  assert.ok(!g.hints.some((h) => h.includes("疑似同主题")), "低于阈值不应提示");
});
