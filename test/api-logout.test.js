import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 退出登录接口的测试：用一个假的宿主把路由接住，不发真实网络请求。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_HOME = path.join(HERE, ".tmp-api");
process.env.DSH_HOME = TMP_HOME;

const { registerApiRoutes, PREFIX } = await import("../lib/api.js");
const { loginCredentialFile, defaultCredentialFile } = await import("../lib/bili-credential.js");

const LOGIN = loginCredentialFile();
const LEGACY = defaultCredentialFile();

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
    call(method, path, body) {
      const route = routes.get(path);
      if (!route) throw new Error("没有注册这条路由：" + path);
      const req = { method, body };
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

function put(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj), "utf8");
}

function fresh() {
  rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
}

after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test("退出登录接口会把两处凭据文件都删掉，并回一句能看懂的话", async () => {
  fresh();
  put(LOGIN, { sessdata: "aa", bili_jct: "bb", buvid3: "cc", dedeuserid: "123", uname: "小明" });
  put(LEGACY, { sessdata: "dd", bili_jct: "ee", buvid3: "ff", dedeuserid: "456" });

  const host = fakeHost();
  registerApiRoutes(host, { getCfg: () => ({}), version: "0.0.0" });

  const r = await host.call("POST", `${PREFIX}/login/logout`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.removed.length, 2);
  assert.match(r.json.message, /退出登录/);
  assert.equal(existsSync(LOGIN), false);
  assert.equal(existsSync(LEGACY), false);
});

test("已经未登录时点退出登录，接口也照常返回，不报错", async () => {
  fresh();
  const host = fakeHost();
  registerApiRoutes(host, { getCfg: () => ({}), version: "0.0.0" });

  const r = await host.call("POST", `${PREFIX}/login/logout`, {});
  assert.equal(r.json.ok, true);
  assert.equal(r.json.removed.length, 0);
  assert.match(r.json.message, /已经是未登录/);
});

test("配置里写死 Cookie 时，接口要说明这一处界面上删不掉", async () => {
  fresh();
  const host = fakeHost();
  registerApiRoutes(host, { getCfg: () => ({ biliCookie: "SESSDATA=zz" }), version: "0.0.0" });

  const r = await host.call("POST", `${PREFIX}/login/logout`, {});
  assert.equal(r.json.ok, true);
  assert.equal(r.json.stillLoggedIn, true);
  assert.match(r.json.message, /配置文件/);
});
