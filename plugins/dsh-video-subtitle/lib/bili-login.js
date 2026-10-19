/**
 * B站 扫码登录：界面上点一下出二维码，手机 B站 扫一下，凭据就自动存好了。
 *
 * 安全约定（这个文件里的每段代码都必须守住）：
 * - 凭据只出现在两个地方：本机内存里的变量，以及 <DSH_HOME>/video-subtitle/bili-login.json 这个文件。
 * - 绝不打印到控制台，绝不写进日志，绝不拼进错误信息，绝不上传到任何地方，绝不跟着错误信息一起抛出去。
 * - 文件权限尽量设成只有本人能读（0600）。Windows 上设不了就跳过，不影响登录结果。
 *
 * 只用 node: 自带的模块，没有第三方依赖。
 * 真正发请求的那个函数可以外面传进来（request），测试传一个假的就能完全离线跑。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 普通 Chrome 的 UA。这几个接口会看 UA，不带会被当成脚本挡回来。 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** 带上 B站 主站来源才正常返回。 */
const REFERER = "https://www.bilibili.com/";

const PASSPORT = "https://passport.bilibili.com";
const API = "https://api.bilibili.com";

/** 一次请求最多等多久，等超了直接报错，不让界面一直转圈。 */
const TIMEOUT_MS = 15000;

/** 二维码大概三分钟过期，跟 B站 自己的有效期一致。 */
const QR_TTL_MS = 180000;

/** 凭据里要认的字段，键名用官方写法；存盘时再转成小写，跟 lib/bili-credential.js 的 FIELDS 对齐。 */
const FIELD_KEYS = ["SESSDATA", "bili_jct", "buvid3", "DedeUserID", "sid"];

/** 拼 Cookie 请求头时只拼这四个，sid 只做记录，B站 校验不用它。 */
const COOKIE_KEYS = ["SESSDATA", "bili_jct", "buvid3", "DedeUserID"];

/** 把异常变成一句能看的文字，兜住各种奇怪的抛出物。 */
const msgOf = (e) => (e?.message ? String(e.message) : String(e ?? "未知错误"));

/** 本机 DSH 的数据目录。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 扫码登录拿到的凭据存在这里。 */
export function loginFile() {
  return path.join(dshHome(), "video-subtitle", "bili-login.json");
}

/**
 * 默认凭据路径。这个是模块加载那一刻算出来的快照，
 * 运行时换了 DSH_HOME 想拿到新路径就用 loginFile()。
 */
export const LOGIN_FILE = loginFile();

/** 任务板上给这个名字起的别名，两处都用同一份实现，免得调用方搞混。 */
export const credentialFile = loginFile;

/** 请求这些接口统一带的头。 */
function baseHeaders() {
  return { "User-Agent": UA, Referer: REFERER };
}

/**
 * 自带的请求器：拿 JSON，同时把 set-cookie 一起交出来（登录成功的凭据有一部分在这里）。
 * 返回值形状 { json, headers, status }，注入的假 request 只要给前两个字段就能对上。
 */
async function defaultRequest(url, { method = "GET", headers = {}, body, signal } = {}) {
  if (signal?.aborted) throw new Error("已取消");

  const ctrl = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener?.("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: { ...baseHeaders(), ...(headers ?? {}) },
      body,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    return { json, headers: { "set-cookie": setCookie }, status: res.status };
  } catch (e) {
    if (timedOut) throw new Error(`等了 ${Math.round(TIMEOUT_MS / 1000)} 秒还没有回应`);
    if (signal?.aborted) throw new Error("已取消");
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
    throw new Error(`连不上 ${host || "B站"}：${msgOf(e)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onOuterAbort);
  }
}

/** 外部注入的用外部的，没给就用自带的。 */
function pickRequest(request) {
  return typeof request === "function" ? request : defaultRequest;
}

/** 有的调用方直接把 JSON 返回，有的返回 { json }，两种都认。 */
function bodyOf(res) {
  if (res && typeof res === "object" && "json" in res) return res.json;
  return res;
}

/** 把响应头里的 set-cookie 统一成字符串数组，不管是 Headers、数组还是普通对象。 */
function setCookieList(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie() ?? [];
  if (typeof headers.get === "function") {
    const one = headers.get("set-cookie");
    return one ? [one] : [];
  }
  if (Array.isArray(headers)) {
    return headers.filter((p) => String(p?.[0] ?? "").toLowerCase() === "set-cookie").map((p) => String(p[1] ?? ""));
  }
  const raw = headers["set-cookie"] ?? headers["Set-Cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

/** 解一个百分号编码的片段，编得不对就原样返回，不抛错。 */
function decodePart(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 把一段 query 拆成键值，这里不碰 + 号，免得把值里的加号变成空格。 */
function parseQuery(query) {
  const out = new Map();
  for (const part of String(query ?? "").split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = decodePart(i < 0 ? part : part.slice(0, i));
    const v = i < 0 ? "" : decodePart(part.slice(i + 1));
    if (!k) continue;
    if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/**
 * 从扫码成功返回的那条 url 里把凭据字段解出来。
 * 老坑：SESSDATA 本身带逗号，接口里是 %2C，这里必须解开，不然拼出来的 Cookie 是错的。
 * @param {string} url
 * @returns {{SESSDATA:string, bili_jct:string, buvid3:string, DedeUserID:string, sid:string}}
 */
export function parseCookieFromUrl(url) {
  const out = { SESSDATA: "", bili_jct: "", buvid3: "", DedeUserID: "", sid: "" };
  const raw = String(url ?? "").trim();
  if (!raw) return out;

  let query = "";
  const q = raw.indexOf("?");
  if (q >= 0) query = raw.slice(q + 1);
  const hash = query.indexOf("#");
  if (hash >= 0) query = query.slice(0, hash);
  if (!query) return out;

  const params = parseQuery(query);
  for (const key of FIELD_KEYS) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  return out;
}

/** 把 set-cookie 那几行里的字段补进 map，已经有值的不覆盖。 */
function fillFromSetCookie(list, map) {
  for (const line of list) {
    const first = String(line ?? "").split(";")[0].trim();
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!FIELD_KEYS.includes(name) || !value) continue;
    if (!map[name]) map[name] = value;
  }
  return map;
}

/** 把字段拼成一条能直接塞进请求头 Cookie 的串，空的跳过。 */
function buildCookie(map) {
  return COOKIE_KEYS.filter((k) => String(map?.[k] ?? "").trim())
    .map((k) => `${k}=${String(map[k]).trim()}`)
    .join("; ");
}

/** Cookie 串或对象都转成字段表，认不出来的字段直接丢掉。 */
function cookieToMap(cookie) {
  const map = {};
  if (cookie && typeof cookie === "object") {
    for (const key of FIELD_KEYS) {
      const v = String(cookie[key] ?? "").trim();
      if (v) map[key] = v;
    }
    return map;
  }
  for (const part of String(cookie ?? "").split(";")) {
    const piece = part.trim();
    if (!piece) continue;
    const i = piece.indexOf("=");
    if (i <= 0) continue;
    const name = piece.slice(0, i).trim();
    const value = piece.slice(i + 1).trim();
    if (FIELD_KEYS.includes(name) && value) map[name] = value;
  }
  return map;
}

/**
 * 生成登录二维码。
 * @param {{request?: Function, signal?: AbortSignal}} [opts]
 * @returns {Promise<{qrcodeKey:string, url:string, expiresAt:number}>}
 *   url 是给二维码用的地址；expiresAt 是毫秒时间戳，界面拿它算还剩多少秒。
 */
export async function startLogin({ request, signal } = {}) {
  const send = pickRequest(request);

  let res;
  try {
    res = await send(`${PASSPORT}/x/passport-login/web/qrcode/generate`, {
      method: "GET",
      headers: baseHeaders(),
      signal,
    });
  } catch (e) {
    throw new Error(`生成登录二维码失败，没连上 B站 的登录接口：${msgOf(e)}`);
  }

  const json = bodyOf(res);
  if (!json || Number(json.code) !== 0 || !json.data?.qrcode_key) {
    const code = json?.code ?? "空响应";
    const text = json?.message ? `：${json.message}` : "";
    throw new Error(`生成登录二维码失败，B站 返回 ${code}${text}`);
  }

  return {
    qrcodeKey: String(json.data.qrcode_key),
    url: String(json.data.url ?? ""),
    expiresAt: Date.now() + QR_TTL_MS,
  };
}

/**
 * 问一次扫码进行到哪一步了。
 *
 * 登录成功时返回的 cookie 是给调用方立刻拿去校验、存盘用的，
 * 它会出现在返回值里，但绝不出现在任何提示文字或错误信息里。
 *
 * @param {string} qrcodeKey
 * @param {{request?: Function, signal?: AbortSignal}} [opts]
 * @returns {Promise<{state:"pending"|"scanned"|"expired"|"ok", message:string, cookie?:string, nav?:object}>}
 */
export async function pollLogin(qrcodeKey, { request, signal } = {}) {
  const key = String(qrcodeKey ?? "").trim();
  if (!key) throw new Error("二维码标识是空的，请重新生成一个二维码");

  const send = pickRequest(request);
  let res;
  try {
    res = await send(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, {
      method: "GET",
      headers: baseHeaders(),
      signal,
    });
  } catch (e) {
    throw new Error(`查询扫码状态失败，没连上 B站 的登录接口：${msgOf(e)}`);
  }

  const json = bodyOf(res);
  if (!json || Number(json.code) !== 0) {
    const code = json?.code ?? "空响应";
    const text = json?.message ? `：${json.message}` : "";
    throw new Error(`查询扫码状态失败，B站 返回 ${code}${text}`);
  }

  const data = json.data ?? {};
  const code = Number(data.code);

  if (code === 86101) return { state: "pending", message: "还没有扫码，请用手机 B站 扫这个二维码" };
  if (code === 86090) return { state: "scanned", message: "已经扫码了，请在手机上点确认登录" };
  if (code === 86038) return { state: "expired", message: "二维码过期了，请重新生成一个" };
  if (code !== 0) {
    throw new Error(`查询扫码状态失败，B站 返回了没见过的状态码 ${code}${data.message ? `：${data.message}` : ""}`);
  }

  // 走到这儿说明登录成功了。凭据有两处来源，取并集：
  // 一是 data.url 的 query（明确给回调用的那条），二是响应头的 set-cookie。
  // 两边都有同一个字段时以 data.url 为准。
  const merged = parseCookieFromUrl(data.url);
  fillFromSetCookie(setCookieList(res?.headers), merged);

  const cookie = buildCookie(merged);
  if (!cookie) throw new Error("B站 说登录成功了，但没拿到 SESSDATA，请重新扫一次二维码");

  const result = { state: "ok", message: "登录成功", cookie };

  // 顺手校验一下这个 Cookie 真的能用，顺便把昵称带回去给界面显示。
  // 校验失败不影响「登录成功」这个结论，只是没有昵称而已。
  try {
    const nav = await fetchNav(cookie, { request: send, signal });
    if (nav?.isLogin) result.nav = nav;
  } catch {
    // 校验这一步出问题就算了，调用方自己决定要不要再校验一次
  }

  return result;
}

/**
 * 拿 Cookie 问 B站「我登录了吗、我是谁」。
 * 没登录时只返回 { isLogin:false }，不抛错，免得把「没登录」当成故障。
 * @param {string} cookie
 * @param {{request?: Function, signal?: AbortSignal}} [opts]
 * @returns {Promise<{isLogin:boolean, mid?:string, uname?:string, vip?:boolean}>}
 */
export async function fetchNav(cookie, { request, signal } = {}) {
  const send = pickRequest(request);
  const jar = String(cookie ?? "").trim();

  let res;
  try {
    res = await send(`${API}/x/web-interface/nav`, {
      method: "GET",
      headers: { ...baseHeaders(), ...(jar ? { Cookie: jar } : {}) },
      signal,
    });
  } catch (e) {
    throw new Error(`校验登录状态失败，没连上 B站：${msgOf(e)}`);
  }

  const json = bodyOf(res);
  const data = json?.data ?? {};
  if (Number(json?.code) !== 0 || !data.isLogin) return { isLogin: false };

  return {
    isLogin: true,
    mid: String(data.mid ?? ""),
    uname: String(data.uname ?? ""),
    vip: Number(data.vipStatus ?? data.vip?.status ?? 0) === 1,
  };
}

/**
 * 把凭据存到本机文件里。
 *
 * 写法是「先写临时文件，再整份换上去」：中途断电或者被杀掉，
 * 也不会留下一个写了一半的坏文件。
 * 返回值只有文件路径，绝不包含凭据本身。
 *
 * @param {string|object} cookie 拼好的 Cookie 串，或者已经拆好的字段对象
 * @param {{file?:string, nav?:{uname?:string, mid?:string}}} [opts]
 * @returns {{file:string}}
 */
export function saveCredential(cookie, { file, nav } = {}) {
  const target = String(file ?? "").trim() || loginFile();
  const map = cookieToMap(cookie);
  if (!map.SESSDATA) throw new Error("要保存的凭据里没有 SESSDATA，登录没成功，不写盘");

  const content = {
    sessdata: map.SESSDATA,
    bili_jct: map.bili_jct ?? "",
    buvid3: map.buvid3 ?? "",
    dedeuserid: map.DedeUserID ?? "",
    uname: String(nav?.uname ?? ""),
    mid: String(nav?.mid ?? ""),
    savedAt: new Date().toISOString(),
  };

  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });

  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows 上这个基本不生效，失败就算了，不影响存盘
  }
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // 同上，权限设不上也不影响结果
  }

  return { file: target };
}

/**
 * 读已经存下的凭据，但只回元数据，不回凭据本身。
 * 文件不在、读不出来、或者里面没有 SESSDATA，都算「没有凭据」。
 * @param {{file?:string}} [opts]
 * @returns {{exists:boolean, uname:string, mid:string, savedAt:string, file:string}}
 */
export function readSaved({ file } = {}) {
  const target = String(file ?? "").trim() || loginFile();
  const nothing = { exists: false, uname: "", mid: "", savedAt: "", file: target };

  let obj = null;
  try {
    if (!existsSync(target)) return nothing;
    obj = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return nothing;
  }
  if (!obj || typeof obj !== "object" || !String(obj.sessdata ?? "").trim()) return nothing;

  return {
    exists: true,
    uname: String(obj.uname ?? ""),
    mid: String(obj.mid ?? ""),
    savedAt: String(obj.savedAt ?? ""),
    file: target,
  };
}

/**
 * 把存下的凭据删掉（退出登录）。
 * @param {{file?:string}} [opts]
 * @returns {{removed:boolean}}
 */
export function clearCredential({ file } = {}) {
  const target = String(file ?? "").trim() || loginFile();
  if (!existsSync(target)) return { removed: false };
  rmSync(target, { force: true });
  return { removed: !existsSync(target) };
}
