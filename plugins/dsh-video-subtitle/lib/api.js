/**
 * 插件自己的 HTTP 接口：给界面上的「设置」页面提供数据与动作。
 *
 * 为什么要有它：插件配置原本只写在 profile 的 cordis.patch.yml 里，那是给命令行用户看的；
 * 普通用户必须在图形界面上点几下就能配好。界面不能直接读服务器上的文件，
 * 所以这里把需要的东西做成几个 /api/video-subtitle/... 的接口。
 *
 * 这里只做四类事：报状态、扫码登录、装转写环境、读写设置。字幕正文一律不经过这里。
 */
import { loadCredential, clearCredentials } from "./bili-credential.js";
import {
  startLogin,
  pollLogin,
  fetchNav,
  saveCredential,
  readSaved,
  loginFile,
} from "./bili-login.js";
import { toSvg } from "./qr.js";
import { asrPaths, asrStatus, startSetup, setupState, cancelSetup, installHint } from "./asr-env.js";
import { localStatus, localSetupState, startLocalSetup, cancelLocalSetup } from "./local-env.js";
import { describeSettings, saveSettings, effectiveConfig, settingsFile } from "./settings.js";
import { providersStatus, defaultSaveDir } from "./pipeline.js";

const PREFIX = "/api/video-subtitle";

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`请求内容太大（上限 ${maxBytes} 字节）`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("请求内容不是合法的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 把一条路由挂到宿主上。注册前先清同名残留：插件被热重载或上一次崩溃时，
 * 宿主的路由表里可能还留着同名的旧路由，直接注册会报 duplicate route 让插件起不来。
 */
function mountRoute(host, route) {
  const table = route.kind === "exact" ? host.exact : host.prefixes;
  try {
    if (table && typeof table.delete === "function" && table.has(route.path)) table.delete(route.path);
  } catch {
    /* 清不掉就让注册自己报错，不掩盖真正的问题 */
  }
  return host.register(route);
}

/** 当前生效配置：把界面上存过的设置盖到插件配置上面。 */
function makeConfig(getCfg) {
  return () => effectiveConfig(getCfg() ?? {});
}

/**
 * 登录状态：先看插件配置里直写的 Cookie，再看扫码登录存下的文件，最后看历史凭据文件。
 *
 * 返回的 expired 是给界面用的标记：true 表示「以前登录过，现在这份凭据不管用了」，
 * 和「从来就没登录过」必须分开说 —— 前者要人重新扫一次码，后者只是还没开始。
 */
async function loginState(cfg, { request } = {}) {
  const saved = readSaved({});
  const cred = loadCredential(cfg);
  const who = saved.uname || "";
  if (cred.cookie) {
    let nav = null;
    try {
      nav = await fetchNav(cred.cookie, { request });
    } catch {
      nav = null;
    }
    if (nav?.isLogin) {
      return {
        loggedIn: true,
        expired: false,
        uname: nav.uname || who,
        mid: nav.mid || saved.mid || "",
        vip: nav.vip === true,
        source: cred.source,
        detail: cred.detail,
      };
    }
    // nav 是 null 说明校验这一步根本没问成（断网、被挡），不能算过期：
    // 凭据可能还是好的，凭这个催人重新扫码只会白折腾一次。
    if (!nav) {
      return {
        loggedIn: false,
        expired: false,
        uname: who,
        mid: saved.mid || "",
        source: cred.source,
        detail: `连不上 B站，暂时查不了登录状态（${cred.detail}）`,
      };
    }
    return {
      loggedIn: false,
      expired: true,
      uname: who,
      mid: saved.mid || "",
      source: cred.source,
      detail: `登录凭据已经失效${who ? `（${who}）` : ""}，重新扫一次码就好`,
    };
  }
  return {
    loggedIn: false,
    expired: false,
    uname: "",
    mid: "",
    source: "",
    detail: "还没有登录 B站，官方字幕只能拿到公开的那几条",
  };
}

/**
 * 挂上全部接口。
 * @param ctx Cordis 上下文（要能拿到 webServer 与 effect）
 * @param options {getCfg, version}
 */
export function registerApiRoutes(ctx, { getCfg, version = "", request } = {}) {
  const config = makeConfig(getCfg);
  const routes = [];
  const add = (method, path, handler) => routes.push({ method, path, handler });

  add("GET", `${PREFIX}/status`, async (req, res) => {
    const cfg = config();
    const [login, asr] = await Promise.all([
      loginState(cfg, { request }).catch((e) => ({ loggedIn: false, expired: false, detail: String(e?.message ?? e) })),
      asrStatus(cfg).catch((e) => ({ ready: false, steps: [], error: String(e?.message ?? e) })),
    ]);
    // 本机识别那条是同步体检，不联网，出错也照样把它报出去
    let local;
    try {
      local = localStatus(cfg);
    } catch (e) {
      local = { ready: false, items: [], missing: [], error: String(e?.message ?? e) };
    }
    const providers = providersStatus(cfg).map((p) => ({
      provider: p.provider,
      wired: p.wired,
      optional: p.optional === true,
      placeholder: p.placeholder ?? null,
      missing: p.missing ?? null,
      note: p.note ?? null,
    }));
    sendJson(res, 200, {
      ok: true,
      version,
      login,
      asr,
      local,
      providers,
      settings: describeSettings(cfg),
      dirs: { defaultSaveDir: defaultSaveDir(), loginFile: loginFile(), settingsFile: settingsFile() },
      asrHint: installHint(cfg),
    });
  });

  add("GET", `${PREFIX}/login/qr`, async (req, res) => {
    try {
      const r = await startLogin({});
      sendJson(res, 200, {
        ok: true,
        qrcodeKey: r.qrcodeKey,
        svg: toSvg(r.url, { ec: "M", scale: 6, margin: 3, title: "用手机 B站 扫这个码登录" }),
        expiresAt: r.expiresAt,
      });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `生成二维码失败：${e?.message ?? e}` });
    }
  });

  add("GET", `${PREFIX}/login/poll`, async (req, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const key = url.searchParams.get("key") ?? "";
    if (!key) return sendJson(res, 400, { ok: false, error: "缺少二维码标识" });
    try {
      const r = await pollLogin(key, {});
      if (r.state !== "ok") {
        return sendJson(res, 200, { ok: true, state: r.state, message: r.message });
      }
      const nav = await fetchNav(r.cookie, {});
      if (!nav?.isLogin) {
        return sendJson(res, 200, { ok: true, state: "expired", message: "扫码成功了，但账号没通过验证，请重新扫码" });
      }
      // 存到插件自己的位置，不动用户手工配置的凭据文件
      saveCredential(r.cookie, { nav });
      sendJson(res, 200, { ok: true, state: "ok", message: `登录成功：${nav.uname || nav.mid}`, uname: nav.uname || "", mid: nav.mid ?? "" });
    } catch (e) {
      sendJson(res, 200, { ok: false, state: "error", error: `查询扫码结果失败：${e?.message ?? e}` });
    }
  });

  add("POST", `${PREFIX}/login/logout`, async (req, res) => {
    try {
      const r = clearCredentials(config());
      const notes = [];
      if (r.removed.length) notes.push(`已经退出登录，清掉了 ${r.removed.length} 处登录信息`);
      else notes.push("已经是未登录状态，没有找到要清掉的登录信息");
      if (r.failed.length) notes.push(`有 ${r.failed.length} 处登录信息删不掉：${r.failed.map((f) => `${f.label}（${f.error}）`).join("、")}，请手动删掉这个文件`);
      if (r.inline) notes.push("插件配置里直接写死了一条 Cookie，界面上删不掉，要修改插件配置文件才能去掉");
      sendJson(res, 200, {
        ok: r.failed.length === 0,
        removed: r.removed,
        message: notes.join("；"),
        error: r.failed.length ? `退出登录没做完：${notes.join("；")}` : undefined,
        stillLoggedIn: r.inline,
      });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `退出登录失败：${e?.message ?? e}` });
    }
  });

  add("POST", `${PREFIX}/asr/setup`, async (req, res) => {
    const cfg = config();
    try {
      const r = await startSetup(cfg, {});
      sendJson(res, 200, { ok: true, started: r.started, taskId: r.taskId });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `开始安装失败：${e?.message ?? e}` });
    }
  });

  add("GET", `${PREFIX}/asr/state`, async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, ...setupState() });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `读安装进度失败：${e?.message ?? e}` });
    }
  });

  add("POST", `${PREFIX}/asr/cancel`, async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, ...cancelSetup() });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `取消安装失败：${e?.message ?? e}` });
    }
  });

  // 本机识别（SenseVoice）那条：装三样东西，不要 Python，装在 <DSH_HOME>/video-subtitle/local
  add("POST", `${PREFIX}/local/setup`, async (req, res) => {
    const cfg = config();
    try {
      const r = await startLocalSetup(cfg, {});
      sendJson(res, 200, { ok: true, started: r.started, taskId: r.taskId });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `开始安装失败：${e?.message ?? e}` });
    }
  });

  add("GET", `${PREFIX}/local/state`, async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, ...localSetupState() });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `读安装进度失败：${e?.message ?? e}` });
    }
  });

  add("POST", `${PREFIX}/local/cancel`, async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, ...cancelLocalSetup() });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `取消安装失败：${e?.message ?? e}` });
    }
  });

  add("POST", `${PREFIX}/settings`, async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const patch = body && typeof body === "object" ? body : {};
      const next = saveSettings(patch, {});
      sendJson(res, 200, { ok: true, settings: describeSettings(config()), saved: next });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `保存设置失败：${e?.message ?? e}` });
    }
  });

  add("GET", `${PREFIX}/asr/hint`, async (req, res) => {
    sendJson(res, 200, { ok: true, hint: installHint(config()), paths: asrPaths(config()) });
  });

  const disposers = [];
  for (const route of routes) {
    const path = route.path;
    disposers.push(
      ctx.effect(
        () =>
          mountRoute(ctx.webServer, {
            kind: "exact",
            path,
            handler: async (req, res) => {
              // 只接受对应的方法，其余一律 405，免得界面上的笔误被当成成功
              if (String(req.method ?? "GET").toUpperCase() !== route.method) {
                return sendJson(res, 405, { ok: false, error: `这个地址只接受 ${route.method}` });
              }
              try {
                await route.handler(req, res);
              } catch (e) {
                sendJson(res, 500, { ok: false, error: `插件内部出错：${e?.message ?? e}` });
              }
            },
          }),
        `dsh-video-subtitle: ${route.method} ${path}`,
      ),
    );
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 卸载失败不影响别的路由 */
      }
    }
  };
}

export { PREFIX };
