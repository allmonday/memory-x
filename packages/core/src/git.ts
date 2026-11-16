import { spawn } from "node:child_process";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`无法启动 git：${e.message}`)));
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")} 失败：${err.trim()}`)),
    );
  });
}

/** 确保 dir 是 git 仓库（不是则 init）。 */
export async function ensureGitRepo(dir: string): Promise<void> {
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
  } catch {
    await git(dir, ["init"]);
  }
}

/** 提交全部变更；无变更返回 null，有变更返回 commit sha。 */
export async function snapshot(dir: string, message: string): Promise<string | null> {
  await ensureGitRepo(dir);
  const status = await git(dir, ["status", "--porcelain"]);
  if (status.trim() === "") return null;
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", message]);
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return sha;
}
