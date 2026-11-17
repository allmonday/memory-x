import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ensureGitRepo, snapshot } from "../src/git.ts";

test("嵌套在其它 git 仓库内时，为目录自己 init（不误判父仓库）", async () => {
  const outer = await mkdtemp(join(tmpdir(), "mx-outer-"));
  execFileSync("git", ["init", "-q"], { cwd: outer });

  const inner = join(outer, "memory");
  await mkdir(inner, { recursive: true });

  await ensureGitRepo(inner);
  // inner 必须有自己的 .git，而不是复用 outer 的
  assert.ok(existsSync(join(inner, ".git")), "嵌套目录应拥有独立 .git");
});

test("snapshot 在嵌套场景下提交到自己的仓库", async () => {
  const outer = await mkdtemp(join(tmpdir(), "mx-outer2-"));
  execFileSync("git", ["init", "-q"], { cwd: outer });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(outer, "README"), "outer\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: outer });
  execFileSync("git", ["commit", "-q", "-m", "outer init"], { cwd: outer });

  const inner = join(outer, "memory");
  await mkdir(inner, { recursive: true });
  await writeFile(join(inner, "MEMORY.md"), "# Memory\n", "utf8");

  const sha = await snapshot(inner, "memory: test");
  assert.ok(sha, "应产生 commit");
  const innerLog = execFileSync("git", ["log", "--oneline"], { cwd: inner, encoding: "utf8" });
  assert.match(innerLog, /memory: test/);
  // 父仓库不应包含该提交
  const outerLog = execFileSync("git", ["log", "--oneline"], { cwd: outer, encoding: "utf8" });
  assert.ok(!outerLog.includes("memory: test"), "提交不得落在父仓库");
});
