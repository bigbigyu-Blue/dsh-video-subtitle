/**
 * 读取 B站 登录凭据（只在本机内存里用，绝不打印、绝不写回、绝不上传）。
 *
 * 找凭据的顺序，先找到先用：
 *   1. 插件配置里直接写的整条 Cookie 串（biliCookie）
 *   2. 插件配置指定的文件（biliCredentialFile）
 *   3. 插件自己的设置页扫码登录存下的文件（<DSH_HOME>/video-subtitle/bili-login.json）
 *   4. 历史遗留的凭据文件（<DSH_HOME>/bili-duty/bili_credential.json）
 *
 * 第 3 条是给普通用户用的：他在设置页扫个码，凭据就存好了，不用去翻浏览器。
 * 第 4 条是为了已经在用的老用户不用重新登录。
 *
 * 凭据文件格式（字段名大小写都认）：
 *   { "sessdata": "...", "bili_jct": "...", "buvid3": "...", "dedeuserid": "..." }
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 设置页扫码登录存下的凭据文件。 */
export function loginCredentialFile() {
  return path.join(dshHome(), "video-subtitle", "bili-login.json");
}

/** 历史遗留的凭据文件，只为了不让老用户重新登录一次。 */
export function defaultCredentialFile() {
  return path.join(dshHome(), "bili-duty", "bili_credential.json");
}

/** key 一律小写，拼 Cookie 时再还原成官方写法。 */
const FIELDS = { sessdata: "SESSDATA", bili_jct: "bili_jct", buvid3: "buvid3", dedeuserid: "DedeUserID" };

const cache = { file: "", mtimeMs: 0, cookie: "", source: "", detail: "" };

function fromObject(obj) {
  const parts = [];
  for (const [k, name] of Object.entries(FIELDS)) {
    const v = String(obj?.[k] ?? obj?.[name] ?? "").trim();
    if (v) parts.push(`${name}=${v}`);
  }
  return parts.join("; ");
}

function readOne(file, label) {
  let st = null;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (cache.file === file && cache.mtimeMs === st.mtimeMs) return { ...cache };
  let obj = null;
  try {
    obj = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { cookie: "", source: "", detail: `${label}读不出来：${e?.message ?? e}`, file, mtimeMs: st.mtimeMs };
  }
  const cookie = fromObject(obj);
  const who = String(obj?.uname ?? "").trim();
  // 只报「有没有 SESSDATA」就够了：buvid3、bili_jct 这些缺了也不影响拿官方字幕，
  // 实测带不带得到的轨完全一样，写在界面上只会让人以为出了故障。
  const detail = cookie ? `${label}已加载${who ? `（${who}）` : ""}` : `${label}里没有 SESSDATA`;
  const hit = { cookie, source: cookie ? "file" : "", detail, file: cookie ? file : "", mtimeMs: st.mtimeMs };
  if (cookie) Object.assign(cache, hit);
  return hit;
}

/**
 * @returns {{cookie:string, source:string, detail:string}} cookie 为空串表示没找到凭据。
 * detail 是给人看的说明，只写清凭据从哪来（和登录名），绝不包含任何凭据值，也不报缺了哪个次要字段。
 */
export function loadCredential(cfg = {}) {
  const inline = String(cfg.biliCookie ?? "").trim();
  if (inline) return { cookie: inline, source: "config", detail: "使用配置里直接写的 Cookie" };

  const explicit = String(cfg.biliCredentialFile ?? "").trim();
  if (explicit) {
    const hit = readOne(explicit, "登录凭据文件");
    return hit ? { cookie: hit.cookie, source: hit.source, detail: hit.detail } : { cookie: "", source: "", detail: `没有找到登录凭据文件：${explicit}` };
  }

  const scanned = readOne(loginCredentialFile(), "设置页扫码登录的凭据");
  if (scanned?.cookie) return { cookie: scanned.cookie, source: "login", detail: scanned.detail };

  const legacy = readOne(defaultCredentialFile(), "历史凭据文件");
  if (legacy?.cookie) return { cookie: legacy.cookie, source: "file", detail: legacy.detail };

  return {
    cookie: "",
    source: "",
    detail: "还没有登录 B站。到「设置 → 视频字幕」里点一下扫码登录，官方字幕才会返回地址。",
  };
}

/**
 * 退出登录：把能找到的凭据文件全部删掉。
 *
 * 只删一个文件是不够的 —— 老用户的历史凭据文件还在时，删掉扫码登录那份，
 * 下一次读凭据又会回落到历史文件，界面上看起来就是「点了没反应」。
 *
 * @returns {{removed:string[], failed:{label:string,error:string}[], inline:boolean}}
 *   removed 是删掉的来源说明，failed 是删不掉的，inline 表示配置里写死了 Cookie（界面上删不掉，只能改配置文件）。
 */
export function clearCredentials(cfg = {}) {
  const targets = [];
  const explicit = String(cfg.biliCredentialFile ?? "").trim();
  if (explicit) targets.push({ file: explicit, label: "配置里指定的登录凭据文件" });
  targets.push({ file: loginCredentialFile(), label: "设置页扫码登录的凭据" });
  targets.push({ file: defaultCredentialFile(), label: "历史凭据文件" });

  const removed = [];
  const failed = [];
  for (const { file, label } of targets) {
    try {
      if (!existsSync(file)) continue;
      rmSync(file, { force: true });
      removed.push(label);
    } catch (e) {
      failed.push({ label, error: String(e?.message ?? e) });
    }
  }

  Object.assign(cache, { file: "", mtimeMs: 0, cookie: "", source: "", detail: "" });
  const inline = Boolean(String(cfg.biliCookie ?? "").trim());
  return { removed, failed, inline };
}

export { UA };
