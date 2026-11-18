import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTree, suggestPath } from "../src/lint.ts";
import { parseMarkdown } from "../src/parser.ts";

test("lint：冗余层（一对一链）", () => {
  const root = parseMarkdown("# Memory\n\n## 个人资料\n### 个人资料\n#### 基本信息\n- 姓名\n");
  const issues = lintTree(root);
  assert.ok(issues.some((i) => i.rule === "redundant-layer" && i.path === "个人资料/个人资料"));
});

test("lint：深度超限", () => {
  const root = parseMarkdown(
    "# Memory\n\n## A\n### B\n#### C\n##### D\n###### E\n- 过深\n",
  );
  assert.ok(lintTree(root).some((i) => i.rule === "depth"));
});

test("lint：叶子堆积与广度过大", () => {
  const leaves = Array.from({ length: 25 }, (_, i) => `- 事实${i}`).join("\n");
  const children = Array.from({ length: 11 }, (_, i) => `### 子${i}`).join("\n");
  const root = parseMarkdown(`# Memory\n\n## 域\n${leaves}\n${children}\n`);
  const issues = lintTree(root);
  assert.ok(issues.some((i) => i.rule === "leaf-pile"));
  assert.ok(issues.some((i) => i.rule === "breadth"));
});

test("lint：兄弟重名与时间性命名", () => {
  const root = parseMarkdown("# Memory\n\n## 项目\n### A\n## 项目\n### B\n## 2026年计划\n- x\n");
  const issues = lintTree(root);
  assert.ok(issues.some((i) => i.rule === "dup-title"));
  assert.ok(issues.some((i) => i.rule === "temporal-name" && i.path === "2026年计划"));
});

test("lint：健康树零报告", () => {
  const root = parseMarkdown("# Memory\n\n## 工作\n### pi调研\n- 事实A\n- 事实B\n- 事实C\n### nexusx\n- 事实D\n\n## 生活\n### 健康\n- 体检\n### 饮食\n- 均衡\n");
  assert.equal(lintTree(root).length, 0);
});

test("lint：顶层域过多", () => {
  const doms = Array.from({ length: 8 }, (_, i) => `## 域${i}`).join("\n");
  const root = parseMarkdown(`# Memory\n${doms}\n`);
  assert.ok(lintTree(root).some((i) => i.rule === "top-domains"));
});

test("suggestPath：词汇重合定位候选，浅层优先", () => {
  const root = parseMarkdown(
    "# Memory\n\n## 工作\n### pi生态调研\n- 事实\n\n## 生活\n### 兴趣\n- x\n",
  );
  const cands = suggestPath(root, "pi 的存储方案调研结论");
  assert.ok(cands.length >= 1);
  assert.equal(cands[0], "工作/pi生态调研");
});

test("suggestPath：无重合返回空", () => {
  const root = parseMarkdown("# Memory\n\n## 工作\n- x\n");
  assert.deepEqual(suggestPath(root, "完全无关的内容"), []);
});
