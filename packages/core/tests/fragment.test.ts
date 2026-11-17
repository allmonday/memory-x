import assert from "node:assert/strict";
import { test } from "node:test";
import { tocDigest } from "../src/digest.ts";
import { applyOutline, parseFragment } from "../src/fragment.ts";
import { parseMarkdown } from "../src/parser.ts";

test("tocDigest：层级、叶子计数与截断", () => {
  const root = parseMarkdown(`# Memory

## 工作
### 调研
- 事实一
- 事实二

### 待办
- 任务

## 生活
- 体检
`);
  const toc = tocDigest(root);
  assert.match(toc, /- 工作 \[3\]/);
  assert.match(toc, /  - 调研 \[2\]/);
  assert.match(toc, /- 生活 \[1\]/);

  const short = tocDigest(root, { maxChars: 20 });
  assert.ok(short.length <= 20 + "\n…（已截断，用 memory_read 下钻）".length);
  assert.match(short, /已截断/);
});

test("tocDigest 空树", () => {
  assert.equal(tocDigest(parseMarkdown("# Memory\n")), "（记忆树为空）");
});

test("parseFragment：相对层级 + 首标题前列表", () => {
  const frag = parseFragment(`- 归属叶子
### 子节点甲
- 甲的事实

#### 更深
- 深处
`);
  assert.deepEqual(frag.leaves, ["归属叶子"]);
  assert.equal(frag.children.length, 1);
  const a = frag.children[0]!;
  assert.equal(a.title, "子节点甲");
  assert.deepEqual(a.leaves, ["甲的事实"]);
  assert.equal(a.children[0]!.title, "更深");
});

test("parseFragment：层级跳跃报错", () => {
  assert.throws(() => parseFragment("### a\n##### 跳了\n"), /层级跳跃/);
});

test("applyOutline：整体替换子树并落为规范结构", () => {
  const root = parseMarkdown(`# Memory

## 工作
### 旧结构
- 旧事实
`);
  const r = applyOutline(
    root,
    "工作",
    `### 新结构
- 新事实一

#### 子
- 子事实
`,
  );
  assert.equal(r.changed, true);
  const work = root.children[0]!;
  assert.equal(work.children.length, 1);
  assert.equal(work.children[0]!.title, "新结构");
  assert.deepEqual(work.children[0]!.leaves, ["新事实一"]);
  assert.equal(work.children[0]!.children[0]!.leaves[0], "子事实");
});

test("applyOutline：内容相同则 changed=false", () => {
  const root = parseMarkdown("# Memory\n\n## 工作\n- 事实\n");
  const r = applyOutline(root, "工作", "- 事实\n");
  assert.equal(r.changed, false);
});

test("applyOutline：目标不存在时沿路径创建", () => {
  const root = parseMarkdown("# Memory\n");
  const r = applyOutline(root, "新域/子域", "### 内容\n- x\n");
  assert.equal(r.changed, true);
  assert.equal(r.resolvedPath, "新域/子域");
  assert.equal(root.children[0]!.children[0]!.children[0]!.leaves[0], "x");
});

test("applyOutline：过大 outline 拒绝", () => {
  const root = parseMarkdown("# Memory\n");
  const big = Array.from({ length: 301 }, (_, i) => `- 事实${i}`).join("\n");
  assert.throws(() => applyOutline(root, "域", big), /过大/);
});
