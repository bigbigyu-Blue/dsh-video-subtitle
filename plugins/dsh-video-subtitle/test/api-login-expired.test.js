import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 登录状态接口的测试：用一个假宿主把路由接住，B站 的请求也换成假的，全程离线。
// 要盯住的是三件事：过期的凭据必须被标出来、没登录过不许标成过期、问不通 B站 不许当成过期。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_HOME = path.join(HERE, ".tmp-expired");
process.env.DSH_HOME = TMP_HOME;

const { registerApiRoutes, PREFIX } = await import("../lib/api.js");
const { loginCredentialFile } = await import("../lib/bili-credential.js");

const LOGIN = loginCredentialFile();
const SAVED = { sessdata: "aa", bili_jct: "bb", buvid3: "cc", dedeuserid: "123", uname: "小明" };

function fakeHost() {
  const routes = new Map();
  const host = {
    exact: new Map(),
    prefixes: new Map(),
    webServer: null,
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    call(method, url) {
      const route = routes.get(url.split("?")[0]);
      if (!route) throw new Error("没有注册这条路由：" + url);
      const req = { method, url, body: {} };
      const res = {
        statusCode: 0,
        headers: {},
        setHeader(k, v) {
          this.headers[k] = v;
        },
        end(text) {
          this.body = text;
        },
      };
      return route.handler(req, res).then(() => ({
        status: res.statusCode,
        json: res.body ? JSON.parse(res.body) : null,
      }));
    },
  };
  host.webServer = host;
  return host;
}

/** 造一个问 B站 的假请求器：nav 那张接口回什么由调用方决定。 */
function fakeRequest(nav) {
  return async (url) => {
    if (String(url).includes("/x/web-interface/nav")) return nav;
    throw new Error("这个测试不该再问别的接口：" + url);
  };
}

function put(obj) {
  mkdirSync(path.dirname(LOGIN), { recursive: true });
  writeFileSync(LOGIN, JSON.stringify(obj), "utf8");
}

function fresh() {
  rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
}

after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

const statusOf = async (host) => (await host.call("GET", `${PREFIX}/status`)).json;

test("凭据还在但 B站 说没登录，状态接口要标成已过期，并说清重新扫一次", async () => {
  fresh();
  put(SAVED);
  const host = fakeHost();
  registerApiRoutes(host, { getCfg: () => ({}), version: "0.0.0", request: fakeRequest({ code: 0, data: { isLogin: false } }) });

  const s = await statusOf(host);
  assert.equal(s.login.loggedIn, false);
  assert.equal(s.login.expired, true);
  assert.match(s.login.detail, /失效/);
  assert.match(s.login.detail, /重新扫/);
  // 以前登录过的名字要带出来，好让用户认得出这是自己的账号过期了
  assert.equal(s.login.uname, "小明");
});

test("从来没有登录过的时候不许标成过期", async () => {
  fresh();
  const host = fakeHost();
  registerApiRoutes(host, { getCfg: () => ({}), version: "0.0.0", request: fakeRequest({ code: 0, data: { isLogin: false } }) });

  const s = await statusOf(host);
  assert.equal(s.login.loggedIn, false);
  assert.equal(s.login.expired, false);
  assert.match(s.login.detail, /还没有登录/);
});

test("校验登录状态时连不上 B站，要说查不了，不许当成过期催人重扫", async () => {
  fresh();
  put(SAVED);
  const host = fakeHost();
  registerApiRoutes(host, {
    getCfg: () => ({}),
    version: "0.0.0",
    request: async () => {
      throw new Error("连不上 api.bilibili.com");
    },
  });

  const s = await statusOf(host);
  assert.equal(s.login.loggedIn, false);
  assert.equal(s.login.expired, false);
  assert.match(s.login.detail, /查不了/);
});

test("凭据还能用时状态是已登录，不出现过期的提醒", async () => {
  fresh();
  put(SAVED);
  const host = fakeHost();
  registerApiRoutes(host, {
    getCfg: () => ({}),
    version: "0.0.0",
    request: fakeRequest({ code: 0, data: { isLogin: true, mid: 1195131470, uname: "小明" } }),
  });

  const s = await statusOf(host);
  assert.equal(s.login.loggedIn, true);
  assert.equal(s.login.expired, false);
  assert.equal(s.login.uname, "小明");
});
