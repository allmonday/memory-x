import { open, rename } from "node:fs/promises";

/**
 * 原子写：同目录临时文件 + fsync + rename。
 * rename 在 POSIX 与 Windows 上均具原子性；崩溃时要么旧内容要么新内容，
 * 不会出现半文件。（目录项 fsync 从简——单机单人场景 rename 已足够。）
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}
