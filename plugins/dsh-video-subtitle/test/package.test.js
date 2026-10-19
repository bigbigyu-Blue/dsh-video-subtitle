import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// 这一组只查一件最贵的错：插件清单写得不对，界面那一半整块不会出现在 DSH 设置里，
// 而且宿主只在进程启动时读一次清单，写错了当场看不出来，重启也只会安静地少一页。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("清单里声明了客户端一半，平台是 web", () => {
  assert.equal(typeof pkg.dsh, "object");
  assert.equal(typeof pkg.dsh.client, "object");
  assert.equal(pkg.dsh.client.platform, "web");
});

test("清单里的 ./client 指向真实存在的文件", () => {
  const rel = pkg.exports && pkg.exports["./client"];
  assert.equal(typeof rel, "string");
  assert.ok(existsSync(join(root, rel)), "./client 指向的文件不存在：" + rel);
});

test("客户端文件用的是宿主认的那种写法", () => {
  const code = readFileSync(join(root, pkg.exports["./client"]), "utf8");
  assert.match(code, /__ModuleLoader__\.load\(/);
  assert.match(code, /exports\.apply\s*=|module\.exports\s*=\s*\{/);
  // 客户端这一半只能同步拿平台的 react，别的依赖一律不准有
  const requires = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ["react"]);
});

test("默认配置文件的路径真的存在", () => {
  const rel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  assert.equal(typeof rel, "string");
  assert.ok(existsSync(join(root, rel)), "bundle.patch 指向的文件不存在：" + rel);
});

test("服务端入口与声明一致", () => {
  assert.ok(existsSync(join(root, pkg.main)), "main 指向的文件不存在：" + pkg.main);
  assert.ok(existsSync(join(root, pkg.exports["."])), "exports 的根入口不存在：" + pkg.exports["."]);
});

test("版本号是三段数字，且与界面里读的是同一个来源", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const entry = readFileSync(join(root, "lib/index.js"), "utf8");
  // 版本号只准写一处，就是清单；入口现读清单，界面再从接口拿
  assert.doesNotMatch(entry, /version\s*=\s*"\d+\.\d+\.\d+"/);
});
