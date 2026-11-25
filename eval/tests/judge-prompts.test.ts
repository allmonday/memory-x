/**
 * 判分提示词形态单测：口径条款存在性 + 诱答注入（locomo cat5）/缺省（halumem Memory Boundary）。
 * 判分质量本身靠重判对表（scripts/rejudge.ts），这里只锁形态防漂移。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JUDGE_SYSTEM, REFUSE_SYSTEM, judgeUser, refuseUser } from "../memory/prompts.ts";

test("judgeUser：覆盖式等价口径（超集/措辞差异放行，缺关键内容判错）", () => {
  const u = judgeUser("What activities?", "pottery, camping", "running, pottery, camping and more");
  assert.match(u, /Question: What activities\?/);
  assert.match(u, /Grade by coverage/);
  assert.match(u, /additional true detail or extra items/);
  assert.match(u, /misses or contradicts a key part/);
});

test("refuseUser：无诱答（halumem Memory Boundary 形态）", () => {
  const u = refuseUser("What is the middle name?", "I have no record of a middle name.");
  assert.match(u, /unanswerable from the assistant's memory/);
  assert.doesNotMatch(u, /Tempting wrong answer/);
  assert.match(u, /pointed out the false premise/);
});

test("refuseUser：带诱答（locomo cat5 对调陷阱形态）", () => {
  const u = refuseUser("What instrument does Caroline play?", "She plays guitar.", "clarinet and violin");
  assert.match(u, /Tempting wrong answer \(what a careless assistant would assert\): clarinet and violin/);
  assert.match(u, /matching the tempting answer or inventing specifics/);
});

test("判分回执约束：system 均要求单词回执", () => {
  assert.match(JUDGE_SYSTEM, /exactly one word: CORRECT or WRONG/);
  assert.match(REFUSE_SYSTEM, /exactly one word: CORRECT or WRONG/);
});
