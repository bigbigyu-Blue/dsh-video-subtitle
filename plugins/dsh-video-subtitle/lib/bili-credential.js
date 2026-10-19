/**
 * 读取本机已有的 B站 登录凭据（只在本机内存里用，绝不打印、绝不写回、绝不上传）。
 *
 * 凭据文件格式（<DSH_HOME>/bili-duty/bili_credential.json）：
 *   { "sessdata": "...", "bili_jct": "...", "buvid3": "...", "dedeuserid": "..." }
 * 也接受配置文件里直接写一整条 Cookie 串（biliCookie）。
 */
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function defaultCredentialFile() {
  return path.join(dshHome(), "bili-duty", "bili_credential.json");
}

/** key 一律小写，拼 Cookie 时再还原成官方写法。 */
const FIELDS = { sessdata: "SESSDATA", bili_jct: "bili_jct", buvid3: "buvid3", dedeuserid: "DedeUserID" };

const cache = { file: "", mtimeMs: 0, cookie: "", source: "" };

function fromObject(obj) {
  const parts = [];
  for (const [k, name] of Object.entries(FIELDS)) {
    const v = String(obj?.[k] ?? obj?.[name] ?? "").trim();
    if (v) parts.push(`${name}=${v}`);
  }
  return parts.join("; ");
}

/**
 * @returns {{cookie:string, source:string, detail:string}} cookie 为空串表示没找到凭据。
 * detail 是给人看的说明，写清楚凭据从哪来、缺没缺字段，但绝不包含任何凭据值。
 */
export function loadCredential(cfg = {}) {
  const inline = String(cfg.biliCookie ?? "").trim();
  if (inline) return { cookie: inline, source: "config", detail: "使用配置里直接写的 Cookie" };

  const file = String(cfg.biliCredentialFile ?? "").trim() || defaultCredentialFile();
  let st = null;
  try {
    st = statSync(file);
  } catch {
    return { cookie: "", source: "", detail: `没有找到登录凭据文件：${file}` };
  }
  if (cache.file === file && cache.mtimeMs === st.mtimeMs) {
    return { cookie: cache.cookie, source: cache.source, detail: cache.detail };
  }
  let obj = null;
  try {
    obj = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { cookie: "", source: "", detail: `登录凭据文件读不出来：${e?.message ?? e}` };
  }
  const cookie = fromObject(obj);
  const missing = Object.keys(FIELDS).filter((k) => !String(obj?.[k] ?? obj?.[FIELDS[k]] ?? "").trim());
  const detail = cookie
    ? `登录凭据已加载（${file}）${missing.length ? `，缺字段 ${missing.join("/")}` : ""}`
    : `登录凭据文件里没有 SESSDATA：${file}`;
  Object.assign(cache, { file, mtimeMs: st.mtimeMs, cookie, source: "file", detail });
  return { cookie, source: cookie ? "file" : "", detail };
}

export { UA };
