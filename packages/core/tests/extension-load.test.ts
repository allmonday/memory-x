import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 扩展文件加载测试：捕获语法错误/坏 import。
 * （模块级只定义函数无副作用，import 即验证；真正的运行时行为由 pi E2E 覆盖）
 */
test("pi-extension 模块可加载（语法/import 完整性）", async () => {
  const mod = await import("../../pi-extension/index.ts");
  assert.equal(typeof mod.default, "function", "默认导出应为扩展工厂函数");
});
