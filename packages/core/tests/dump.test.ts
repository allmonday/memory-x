import assert from "node:assert/strict";
import { test } from "node:test";
import { dumpTree } from "../src/digest.ts";
import { parseMarkdown } from "../src/parser.ts";

const DOC = `# Memory

## 工作
### 调研
- 事实一
- 事实二

## 生活
- 体检
`;

test("dumpTree：结构视图（全深度、计数、content 标记）", () => {
  const root = parseMarkdown(DOC);
  root.children[0]!.children[0]!.content = "完整正文";

  const out = dumpTree(root);
  assert.match(out, /^# Memory$/m);
  assert.match(out, /├─ 工作 \[2\]/);
  assert.match(out, /│  └─ 调研 \[2\] ◆/);
  assert.match(out, /└─ 生活 \[1\]/);
  // 结构模式不含叶子
  assert.ok(!out.includes("· 事实一"));
});

test("dumpTree --full：含叶子", () => {
  const root = parseMarkdown(DOC);
  const out = dumpTree(root, { full: true });
  assert.match(out, /· 事实一/);
  assert.match(out, /· 体检/);
});

test("dumpTree 空树", () => {
  assert.equal(dumpTree(parseMarkdown("# Memory\n")), "# Memory");
});
