import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOGIN_FILE,
  loginFile,
  startLogin,
  pollLogin,
  parseCookieFromUrl,
  fetchNav,
  saveCredential,
  readSaved,
  clearCredential,
} from "../lib/bili-login.js";

// 测试全部用假的请求器，一次真实网络都不发。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(HERE, ".tmp-login");

// 扫码成功时 B站 给的那条 url。SESSDATA 里的逗号是 %2C 编码过的，这是最容易踩的老坑。
const OK_URL =
  "https://passport.biligame.com/crossDomain?DedeUserID=123&SESSDATA=abc%2Cdef&bili_jct=jj&buvid3=bb&sid=ss";

/** 造一个假的请求器：按地址里的关键字分派，并把每次请求记在 calls 上。 */
function fakeRequest(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [key, value] of Object.entries(routes)) {
      if (String(url).includes(key)) {
        return typeof value === "function" ? value(url, opts) : value;
      }
    }
    throw new Error(`假请求器里没配这个地址：${url}`);
  };
  fn.calls = calls;
  return fn;
}

/** poll 接口的响应外壳。 */
function pollBody(data) {
  return { code: 0, data };
}

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("默认凭据文件在 video-subtitle 目录下，叫 bili-login.json", () => {
  assert.equal(path.basename(loginFile()), "bili-login.json");
  assert.equal(path.basename(path.dirname(loginFile())), "video-subtitle");
  assert.equal(path.basename(LOGIN_FILE), "bili-login.json");
});

test("startLogin 拿到二维码地址和过期时间", async () => {
  const request = fakeRequest({
    "qrcode/generate": {
      code: 0,
      data: {
        url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc123&from=",
        qrcode_key: "abc123",
      },
    },
  });

  const before = Date.now();
  const out = await startLogin({ request });

  assert.equal(out.qrcodeKey, "abc123");
  assert.match(out.url, /qrcode_key=abc123/);
  assert.ok(out.expiresAt > before, "过期时间要在将来");
  assert.equal(typeof out.expiresAt, "number");
});

test("startLogin 请求报错时抛中文错误", async () => {
  const request = async () => {
    throw new Error("socket hang up");
  };

  await assert.rejects(() => startLogin({ request }), (e) => {
    assert.match(e.message, /生成登录二维码失败/);
    assert.match(e.message, /socket hang up/);
    return true;
  });
});

test("startLogin 碰到 code 不为 0 也抛中文错误", async () => {
  const request = fakeRequest({ "qrcode/generate": { code: -400, message: "请求错误" } });

  await assert.rejects(() => startLogin({ request }), /生成登录二维码失败.*-400.*请求错误/);
});

test("pollLogin 86101 是还没扫码", async () => {
  const request = fakeRequest({
    "qrcode/poll": pollBody({ code: 86101, message: "未扫码", url: "", refresh_token: "", timestamp: 0 }),
  });

  const out = await pollLogin("abc123", { request });
  assert.equal(out.state, "pending");
  assert.equal(out.message, "还没有扫码，请用手机 B站 扫这个二维码");
  assert.equal(out.cookie, undefined, "没登录成功就不该有 cookie");
});

test("pollLogin 86090 是扫了还没确认", async () => {
  const request = fakeRequest({
    "qrcode/poll": pollBody({ code: 86090, message: "二维码已扫码未确认" }),
  });

  const out = await pollLogin("abc123", { request });
  assert.equal(out.state, "scanned");
  assert.equal(out.message, "已经扫码了，请在手机上点确认登录");
});

test("pollLogin 86038 是二维码过期", async () => {
  const request = fakeRequest({
    "qrcode/poll": pollBody({ code: 86038, message: "二维码已失效" }),
  });

  const out = await pollLogin("abc123", { request });
  assert.equal(out.state, "expired");
  assert.equal(out.message, "二维码过期了，请重新生成一个");
});

test("pollLogin 0 是登录成功，cookie 从 url 里拼出来", async () => {
  const request = fakeRequest({
    "qrcode/poll": pollBody({ code: 0, url: OK_URL, refresh_token: "rt", timestamp: 1 }),
    "web-interface/nav": { code: 0, data: { isLogin: true, mid: 123, uname: "小明", vipStatus: 0 } },
  });

  const out = await pollLogin("abc123", { request });

  assert.equal(out.state, "ok");
  assert.equal(out.message, "登录成功");
  assert.equal(out.cookie, "SESSDATA=abc,def; bili_jct=jj; buvid3=bb; DedeUserID=123");
  assert.equal(out.cookie.includes("sid="), false, "sid 只做记录，不拼进 Cookie");
  assert.deepEqual(out.nav, { isLogin: true, mid: "123", uname: "小明", vip: false });
});

test("pollLogin 成功时 set-cookie 里的字段也会补进来，两边取并集", async () => {
  // url 里只有 SESSDATA，剩下的几个字段只在响应头里
  const request = fakeRequest({
    "qrcode/poll": {
      code: 0,
      data: { code: 0, url: "https://passport.biligame.com/crossDomain?SESSDATA=abc%2Cdef" },
      headers: {
        "set-cookie": [
          "bili_jct=jj; Path=/; Domain=.bilibili.com",
          "buvid3=bb; Path=/",
          "DedeUserID=123; Path=/",
          "sid=ss; Path=/",
        ],
      },
    },
    "web-interface/nav": { code: 0, data: { isLogin: true, mid: 123, uname: "小明" } },
  });

  const out = await pollLogin("abc123", { request });
  assert.equal(out.state, "ok");
  assert.equal(out.cookie, "SESSDATA=abc,def; bili_jct=jj; buvid3=bb; DedeUserID=123");
});

test("pollLogin 也认 getSetCookie() 那种响应头对象", async () => {
  const request = fakeRequest({
    "qrcode/poll": {
      code: 0,
      data: { code: 0, url: "?SESSDATA=abc%2Cdef" },
      headers: { getSetCookie: () => ["bili_jct=jj; Path=/"] },
    },
    "web-interface/nav": { code: 0, data: { isLogin: true, mid: 1, uname: "x" } },
  });

  const out = await pollLogin("abc123", { request });
  assert.match(out.cookie, /^SESSDATA=abc,def; bili_jct=jj$/);
});

test("pollLogin 成功但一个字段都没拿到时抛中文错误且不含凭据", async () => {
  const request = fakeRequest({
    "qrcode/poll": pollBody({ code: 0, url: "https://passport.biligame.com/crossDomain" }),
  });

  await assert.rejects(() => pollLogin("abc123", { request }), (e) => {
    assert.match(e.message, /没拿到 SESSDATA/);
    assert.equal(e.message.includes("SESSDATA="), false, "错误信息里不能出现凭据");
    return true;
  });
});

test("pollLogin 的请求失败时错误信息里不出现凭据", async () => {
  const request = async () => {
    throw new Error("ECONNRESET");
  };

  await assert.rejects(() => pollLogin("abc123", { request }), (e) => {
    assert.match(e.message, /查询扫码状态失败/);
    assert.equal(e.message.includes("SESSDATA"), false);
    return true;
  });
});

test("parseCookieFromUrl 把 %2C 解成逗号，五个字段都解出来", () => {
  const out = parseCookieFromUrl(OK_URL);
  assert.deepEqual(out, {
    SESSDATA: "abc,def",
    bili_jct: "jj",
    buvid3: "bb",
    DedeUserID: "123",
    sid: "ss",
  });
});

test("parseCookieFromUrl 面对空串、没有 query、缺字段都不抛错", () => {
  const empty = { SESSDATA: "", bili_jct: "", buvid3: "", DedeUserID: "", sid: "" };
  assert.deepEqual(parseCookieFromUrl(""), empty);
  assert.deepEqual(parseCookieFromUrl("https://passport.biligame.com/crossDomain"), empty);
  assert.deepEqual(parseCookieFromUrl(null), empty);
  assert.deepEqual(parseCookieFromUrl("?DedeUserID=9#foo=1"), {
    SESSDATA: "",
    bili_jct: "",
    buvid3: "",
    DedeUserID: "9",
    sid: "",
  });
});

test("fetchNav 登录成功时给出账号信息", async () => {
  const request = fakeRequest({
    "web-interface/nav": {
      code: 0,
      data: { isLogin: true, mid: 7788, uname: "小红", vipStatus: 1 },
    },
  });

  const nav = await fetchNav("SESSDATA=abc,def", { request });
  assert.deepEqual(nav, { isLogin: true, mid: "7788", uname: "小红", vip: true });
  assert.equal(request.calls[0].opts.headers.Cookie, "SESSDATA=abc,def", "要把 Cookie 带上");
});

test("fetchNav 没登录时只回 isLogin:false，不当成故障", async () => {
  const request = fakeRequest({
    "web-interface/nav": { code: -101, message: "账号未登录", data: { isLogin: false } },
  });

  const nav = await fetchNav("SESSDATA=", { request });
  assert.deepEqual(nav, { isLogin: false });
});

test("saveCredential 写进文件，键名是小写，返回值里没有凭据", () => {
  const file = path.join(TMP_DIR, "bili-login.json");

  const out = saveCredential("SESSDATA=abc,def; bili_jct=jj; buvid3=bb; DedeUserID=123", {
    file,
    nav: { uname: "小明", mid: "123" },
  });

  assert.deepEqual(out, { file });
  assert.equal(JSON.stringify(out).includes("SESSDATA="), false, "返回值里不能出现凭据");
  assert.equal(existsSync(file), true, "文件要写出来");

  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved), ["sessdata", "bili_jct", "buvid3", "dedeuserid", "uname", "mid", "savedAt"]);
  assert.equal(saved.sessdata, "abc,def");
  assert.equal(saved.bili_jct, "jj");
  assert.equal(saved.buvid3, "bb");
  assert.equal(saved.dedeuserid, "123");
  assert.equal(saved.uname, "小明");
  assert.equal(saved.mid, "123");
  assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("saveCredential 没传 SESSDATA 时拒绝写盘", () => {
  const file = path.join(TMP_DIR, "bili-login.json");
  assert.throws(() => saveCredential("bili_jct=jj", { file }), /没有 SESSDATA/);
  assert.equal(existsSync(file), false);
});

test("readSaved 只回元数据，不含凭据", () => {
  const file = path.join(TMP_DIR, "bili-login.json");
  saveCredential("SESSDATA=abc,def; bili_jct=jj; buvid3=bb; DedeUserID=123", {
    file,
    nav: { uname: "小明", mid: "123" },
  });

  const saved = readSaved({ file });
  assert.equal(saved.exists, true);
  assert.equal(saved.uname, "小明");
  assert.equal(saved.mid, "123");
  assert.equal(saved.file, file);
  assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(saved).includes("abc,def"), false, "不许把凭据本身读出来");
});

test("readSaved 碰到没有文件或坏文件就报不存在", () => {
  const missing = path.join(TMP_DIR, "没有这个文件.json");
  assert.equal(readSaved({ file: missing }).exists, false);

  // 文件在、但里面不是 JSON 或者是空的，都当没有凭据
  const broken = path.join(TMP_DIR, "broken.json");
  writeFileSync(broken, "这不是 JSON", "utf8");
  assert.equal(readSaved({ file: broken }).exists, false);

  const noSess = path.join(TMP_DIR, "no-sess.json");
  writeFileSync(noSess, JSON.stringify({ bili_jct: "jj" }), "utf8");
  assert.equal(readSaved({ file: noSess }).exists, false);
});

test("clearCredential 删掉文件后 readSaved 就报不存在", () => {
  const file = path.join(TMP_DIR, "bili-login.json");
  saveCredential("SESSDATA=abc,def", { file, nav: { uname: "小明", mid: "123" } });
  assert.equal(readSaved({ file }).exists, true);

  assert.deepEqual(clearCredential({ file }), { removed: true });
  assert.equal(existsSync(file), false);
  assert.equal(readSaved({ file }).exists, false);

  // 再删一次不该抛错
  assert.deepEqual(clearCredential({ file }), { removed: false });
});
