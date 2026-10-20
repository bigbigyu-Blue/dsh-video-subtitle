import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 这些测试要在临时目录里跑，所以先把 DSH_HOME 指过去再加载模块。
// 模块里的路径函数是调用时才取 DSH_HOME 的，所以只要在 import 之前设好就行。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_HOME = path.join(HERE, ".tmp-cred");
process.env.DSH_HOME = TMP_HOME;

const { clearCredentials, loadCredential, loginCredentialFile, defaultCredentialFile } = await import(
  "../lib/bili-credential.js"
);

const LOGIN = loginCredentialFile();
const LEGACY = defaultCredentialFile();

function put(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj), "utf8");
}

function fresh() {
  rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
}

after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test("退出登录会把扫码登录和历史凭据两个文件都删掉", () => {
  fresh();
  put(LOGIN, { sessdata: "aa", bili_jct: "bb", buvid3: "cc", dedeuserid: "123", uname: "小明" });
  put(LEGACY, { SESSDATA: "dd", bili_jct: "ee", buvid3: "ff", DedeUserID: "456" });
  assert.equal(loadCredential({}).cookie.includes("SESSDATA=aa"), true);

  const r = clearCredentials({});
  assert.equal(r.removed.length, 2);
  assert.equal(r.failed.length, 0);
  assert.equal(r.inline, false);
  assert.equal(existsSync(LOGIN), false);
  assert.equal(existsSync(LEGACY), false);

  // 删完之后再读，必须真的读不到任何 Cookie，不能又回落到某个文件上
  assert.equal(loadCredential({}).cookie, "");
});

test("只剩历史凭据文件时也能退出登录", () => {
  fresh();
  put(LEGACY, { sessdata: "aa", bili_jct: "bb", buvid3: "cc", dedeuserid: "123" });
  assert.equal(loadCredential({}).cookie.includes("SESSDATA=aa"), true);

  clearCredentials({});
  assert.equal(existsSync(LEGACY), false);
  assert.equal(loadCredential({}).cookie, "");
});

test("配置里写死的 Cookie 删不掉，要明确告诉用户", () => {
  fresh();
  const r = clearCredentials({ biliCookie: "SESSDATA=zz" });
  assert.equal(r.inline, true);
  assert.equal(r.removed.length, 0);
  assert.equal(r.failed.length, 0);
});

test("配置指定的凭据文件也会一起删掉", () => {
  fresh();
  const custom = path.join(TMP_HOME, "自己放的位置", "cookie.json");
  put(custom, { sessdata: "aa", bili_jct: "bb", buvid3: "cc", dedeuserid: "123" });

  const r = clearCredentials({ biliCredentialFile: custom });
  assert.equal(existsSync(custom), false);
  assert.equal(r.removed.length, 1);
  assert.equal(loadCredential({ biliCredentialFile: custom }).cookie, "");
});

test("重复退出登录不报错，也不会假装删掉了东西", () => {
  fresh();
  const first = clearCredentials({});
  assert.equal(first.removed.length, 0);
  const second = clearCredentials({});
  assert.equal(second.removed.length, 0);
  assert.equal(second.failed.length, 0);
});
