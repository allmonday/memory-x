/**
 * LoCoMo adapter 单测：日期解析、类别映射、装载形态；数据缓存存在时附全量
 * schema 快照（10 对话/1986 题/类别分布——上游数据变更时立刻暴露）。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LOCOMO_CATEGORY,
  loadConversation,
  loadLoCoMo,
  openingStatement,
  parseLoCoMoDate,
  type LoComoConversation,
} from "../locomo/adapter.ts";

test("parseLoCoMoDate：官方日期格式全部可解析为 ISO", () => {
  assert.equal(parseLoCoMoDate("1:56 pm on 8 May, 2023"), "2023-05-08");
  assert.equal(parseLoCoMoDate("11:01 am on 17 December, 2022"), "2022-12-17");
  assert.equal(parseLoCoMoDate("12:06 am on 11 November, 2022"), "2022-11-11");
  assert.equal(parseLoCoMoDate("9:55 am on 22 October, 2023"), "2023-10-22");
  assert.equal(parseLoCoMoDate("4:04pm on 20 January, 2023"), "2023-01-20"); // 无空格容忍
  assert.equal(parseLoCoMoDate("not a date"), null);
  assert.equal(parseLoCoMoDate("1:56 pm on 8 Smarch, 2023"), null); // 非法月份
});

test("LOCOMO_CATEGORY：1-5 官方类别全覆盖", () => {
  assert.deepEqual(Object.keys(LOCOMO_CATEGORY).sort(), ["1", "2", "3", "4", "5"]);
  assert.equal(LOCOMO_CATEGORY[1], "Multi-hop");
  assert.equal(LOCOMO_CATEGORY[2], "Single-hop");
  assert.equal(LOCOMO_CATEGORY[3], "Temporal");
  assert.equal(LOCOMO_CATEGORY[4], "Open-domain");
  assert.equal(LOCOMO_CATEGORY[5], "Adversarial");
});

const FIXTURE: LoComoConversation = {
  sample_id: "conv-test",
  conversation: {
    speaker_a: "Alice",
    speaker_b: "Bob",
    session_1_date_time: "10:00 am on 1 March, 2023",
    session_1: [
      { speaker: "Alice", dia_id: "D1:1", text: "I started a new job at the bakery." },
      { speaker: "Bob", dia_id: "D1:2", text: "Congrats!" },
    ],
    session_2_date_time: "3:00 pm on 5 June, 2023",
    session_2: [], // 空 session 应跳过
    session_3_date_time: "8:00 pm on 9 September, 2023",
    session_3: [{ speaker: "Bob", dia_id: "D3:1", text: "My favorite hobby is now pottery." }],
  },
  qa: [
    { question: "Where does Alice work?", answer: "the bakery", evidence: ["D1:1"], category: 2 },
    { question: "When did the meteor shower happen?", adversarial_answer: "last summer", evidence: ["D2:5"], category: 5 },
    { question: "What hobby did Bob take up?", answer: "pottery", evidence: ["D3:1"], category: 1 },
  ],
};

test("loadConversation：装载形态（turn 前缀/日期/空 session 跳过/探针）", () => {
  const c = loadConversation(FIXTURE);
  assert.equal(c.sessionCount, 2); // 空 session 不计
  assert.equal(c.turns.length, 3);
  assert.deepEqual(c.speakers, ["Alice", "Bob"]);
  assert.deepEqual(
    c.turns.map((t) => [t.content, t.date]),
    [
      ["Alice: I started a new job at the bakery.", "2023-03-01"],
      ["Bob: Congrats!", "2023-03-01"],
      ["Bob: My favorite hobby is now pottery.", "2023-09-09"],
    ],
  );
  assert.deepEqual(c.expectRemember, []); // LoCoMo 无写入侧金标
  assert.deepEqual(c.expectReplace, []);
  // 探针：cat5 → refuse；tag 用官方类别名；evidence 保留
  assert.equal(c.probes.length, 3);
  assert.deepEqual(c.probes.map((p) => p.tag), ["Single-hop", "Adversarial", "Multi-hop"]);
  const adv = c.probes[1]!;
  assert.equal(adv.refuse, true);
  assert.equal(adv.answer, null);
  assert.equal(adv.adversarialAnswer, "last summer");
  assert.deepEqual(adv.evidence, ["D2:5"]);
  assert.equal(c.probes[0]!.refuse, false);
  assert.equal(c.probes[2]!.answer, "pottery");
});

test("loadConversation：qps 限流", () => {
  assert.equal(loadConversation(FIXTURE, { qps: 1 }).probes.length, 1);
});

test("openingStatement：双 speaker 框架声明", () => {
  const s = openingStatement("Alice", "Bob");
  assert.match(s, /Alice/);
  assert.match(s, /Bob/);
  assert.match(s, /transcripts of conversations between two people/);
});

// ---------- 真实数据 schema 快照（缓存缺失则跳过） ----------
const DATA = join(homedir(), ".cache", "memory-x", "locomo", "locomo10.json");
test("locomo10.json schema 快照（10 对话/1986 题/类别分布/日期全解析）", { skip: !existsSync(DATA) }, async (t) => {
  const convs = await loadLoCoMo(DATA);
  assert.equal(convs.length, 10);

  const cat: Record<number, number> = {};
  let turns = 0;
  let sessions = 0;
  for (const conv of convs) {
    const c = loadConversation(conv);
    turns += c.turns.length;
    sessions += c.sessionCount;
    for (const p of c.probes) {
      const key = Object.entries(LOCOMO_CATEGORY).find(([, v]) => v === p.tag)?.[0];
      assert.ok(key, `未知类别：${p.tag}`);
      cat[Number(key)] = (cat[Number(key)] ?? 0) + 1;
    }
    // 拒答题全部有诱答字段（对抗题失守归因用）
    for (const p of c.probes) if (p.refuse) assert.ok(p.adversarialAnswer !== undefined);
  }
  assert.deepEqual(cat, { 1: 282, 2: 321, 3: 96, 4: 841, 5: 446 });
  assert.equal(Object.values(cat).reduce((a, b) => a + b, 0), 1986);
  assert.equal(turns, 5882);
  assert.equal(sessions, 272); // 288 个 date_time 键中 16 个空 session
  await t; // 占位：node:test 需要异步签名
});
