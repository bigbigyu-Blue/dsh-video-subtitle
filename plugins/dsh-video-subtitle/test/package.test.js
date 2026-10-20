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

test("设置页会把该先做的那张卡片挑出来高亮", () => {
  const code = readFileSync(join(root, pkg.exports["./client"]), "utf8");
  // 一张卡片都不高亮，新用户就得自己想先点哪；挑错就会把人引到还用不上的那一步
  assert.match(code, /nextStep\s*=/, "必须有算出下一步该做什么的那段");
  assert.match(code, /!login\.loggedIn\s*\?\s*"login"/, "没登录时先引导去登录");
  assert.match(code, /!asrReady\s*\?\s*"asr"/, "登录后没装好转写环境就引导去装");
  assert.match(code, /cardCls\("login"\)/, "登录卡片要能被高亮");
  assert.match(code, /cardCls\("asr"\)/, "转写卡片要能被高亮");
});

test("可选的字幕来源在状态里带标记，界面才敢把它画成灰的", () => {
  const pipeline = readFileSync(join(root, "lib/pipeline.js"), "utf8");
  const api = readFileSync(join(root, "lib/api.js"), "utf8");
  // 可选的两条：本机识别、别的站用的下载器。不装它们不影响 B站 那条路，界面上不该显示成故障
  assert.match(pipeline, /optional:\s*pid === "local" \|\| pid === "ytdlp"/);
  assert.match(api, /optional:\s*p\.optional === true/);
});

test("设置页里有「B站 以外的站用的下载器」那张卡片，三条接口都接上了", () => {
  const client = readFileSync(join(root, pkg.exports["./client"]), "utf8");
  const api = readFileSync(join(root, "lib/api.js"), "utf8");
  assert.match(client, /B站 以外的站用的下载器/, "卡片标题要能让人一眼看懂是干什么的");
  assert.match(client, /\/ytdlp\/setup/, "卡片上的按钮要真能发起安装");
  assert.match(client, /\/ytdlp\/state/, "要能看安装进度");
  assert.match(client, /\/ytdlp\/cancel/, "要能取消安装");
  for (const path of ["ytdlp/setup", "ytdlp/state", "ytdlp/cancel"]) {
    assert.ok(api.includes(path), "接口里缺 " + path);
  }
  // 界面上的话不许出现英文缩写与行话
  assert.match(client, /ytdlp: "站上现成字幕"/);
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
