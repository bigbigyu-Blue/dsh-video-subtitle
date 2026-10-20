/**
 * Provider `native` — B站 自己的字幕轨。
 *
 * 两条路，先走后一条：
 *   1) 匿名 `/x/player/v2`：不需要任何凭据，但实测 27 个视频里 0 个能拿到字幕轨。
 *   2) 登录 + WBI 签名 `/x/player/wbi/v2`：实测同一批视频 23/27 拿得到（85%），
 *      而且不少视频有 6~8 条多语言轨。这是「登录后才放出来」的官方 AI 字幕。
 *
 * 结论性的实测：只带 Cookie 不带签名时，一部分视频只回 ai-zh 的元数据、subtitle_url 是空串；
 * 签名和 Cookie 都有才会给真地址。匿名一律只拿到 need_login_subtitle=true。
 * 所以这里宁可多发一次 nav 请求换 WBI key，也不省这一步。
 *
 * 凭据只在本进程内存里拼 Cookie，不打印、不落盘、不上传。
 */
import { utterancesToSrt } from "../srt.js";
import { wbiKeys, wbiSign } from "../wbi.js";
import { loadCredential } from "../bili-credential.js";

export const id = "native";
const API = "https://api.bilibili.com";
const REFERER = "https://www.bilibili.com/";

/** 单条轨的字幕正文 JSON 拉下来。B站 会给 `//xxx` 这种省略协议的地址。 */
function normalizeUrl(u) {
  const s = String(u ?? "").trim();
  if (!s) return "";
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

/** 把 player 接口的 subtitle.subtitles 变成统一的轨列表。 */
function toTracks(list) {
  return (list ?? [])
    .filter((t) => t && (t.subtitle_url || t.subtitle_url_v2))
    .map((t) => ({
      lang: t.lan ?? "",
      langDesc: t.lan_doc ?? t.lan ?? "",
      ai: t.ai_type != null && t.ai_type >= 0,
      url: normalizeUrl(t.subtitle_url || t.subtitle_url_v2),
      urlV2: normalizeUrl(t.subtitle_url_v2 || ""),
    }))
    .filter((t) => t.url);
}

export async function fetchSubtitles({ meta, ctx }) {
  // B站 官方接口只认 B站 的视频编号，别的站一步都不多做，标一笔就走
  if (meta?.platform && meta.platform !== "bilibili") {
    throw ctx.error(id, "UNSUPPORTED", "不是 B站 的视频，这条来源不适用");
  }
  const headers = { Referer: REFERER };
  const cred = loadCredential(ctx.cfg ?? {});
  const cookie = cred.cookie;

  const tried = [];
  let list = [];
  let needLogin = false;

  // 1) 匿名先问一次：有就是白捡，没有也不亏（这一步不发 Cookie，公开字幕的用户隐私更干净）
  try {
    const anon = await ctx.request(`${API}/x/player/v2?bvid=${meta.bvid}&cid=${meta.cid}`, { headers, signal: ctx.signal });
    if (anon?.code === 0) {
      needLogin = Boolean(anon.data?.need_login_subtitle);
      list = toTracks(anon.data?.subtitle?.subtitles);
      if (!list.length) tried.push("匿名 /x/player/v2 无可用轨");
    } else {
      tried.push(`匿名 /x/player/v2 code=${anon?.code} ${anon?.message ?? ""}`);
    }
  } catch (e) {
    tried.push(`匿名 /x/player/v2 失败：${e?.message ?? e}`);
  }

  // 2) 还没有轨就走登录 + WBI 签名那条路
  if (!list.length) {
    if (!cookie) {
      throw ctx.error(
        id,
        "NO_SUBTITLE",
        `${needLogin ? "该视频的 AI 字幕需要登录" : "无公开字幕轨"}；没有找到 B站 登录凭据（${cred.detail}）`,
      );
    }
    const keys = await wbiKeys((u, o) => ctx.request(u, o), { signal: ctx.signal, cookie });
    if (keys.isLogin === false) {
      throw ctx.error(id, "CREDENTIAL_EXPIRED", `登录凭据已失效（${cred.detail}），重新登录 B站 后更新凭据文件`);
    }
    const query = wbiSign({ bvid: meta.bvid, cid: meta.cid }, keys);
    const signed = await ctx.request(`${API}/x/player/wbi/v2?${query}`, { headers: { ...headers, Cookie: cookie }, signal: ctx.signal });
    if (signed?.code !== 0) {
      throw ctx.error(id, "NETWORK", `wbi/player/v2 code=${signed?.code} ${signed?.message ?? ""}`);
    }
    list = toTracks(signed.data?.subtitle?.subtitles);
    needLogin = Boolean(signed.data?.need_login_subtitle);
    if (!list.length) {
      tried.push("登录 + WBI 签名也没有给出字幕地址");
      const lanDoc = (signed.data?.subtitle?.subtitles ?? []).map((t) => t?.lan_doc || t?.lan).filter(Boolean);
      throw ctx.error(
        id,
        "NO_SUBTITLE",
        `该视频没有可下载的 AI 字幕轨${lanDoc.length ? `（只给了 ${lanDoc.join("/")} 的元数据，没有地址）` : ""}${needLogin ? "；接口仍报 need_login" : ""}`,
      );
    }
  }

  // 3) 逐条拉正文。多语言轨里可能有空的，空的直接跳过而不是让整条失败。
  const tracks = [];
  const failed = [];
  for (const t of list) {
    try {
      const body = await ctx.request(t.url, { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, signal: ctx.signal });
      const items = body?.body ?? body?.subtitle?.body ?? [];
      if (!items.length) {
        failed.push(`${t.lang || "?"} 轨正文为空`);
        continue;
      }
      tracks.push({
        lang: t.lang,
        langDesc: t.langDesc,
        ai: t.ai,
        content: utterancesToSrt(
          items.map((b) => ({
            start_time: Number(b.from ?? 0) * 1000,
            end_time: Number(b.to ?? b.from ?? 0) * 1000,
            transcript: b.content,
          })),
        ),
        format: "srt",
      });
    } catch (e) {
      failed.push(`${t.lang || "?"} 轨下载失败：${e?.message ?? e}`);
    }
  }
  if (!tracks.length) {
    throw ctx.error(id, "NO_SUBTITLE", `字幕轨存在但正文都取不到（${failed.join("；")}${tried.length ? `；${tried.join("；")}` : ""}）`);
  }
  return {
    source: id,
    note: `B站官方字幕，${cookie ? "已用登录凭据" : "匿名"}，${tracks.length} 条轨${
      tracks.every((t) => t.ai) ? "（全部为 AI 生成，逐句无标点）" : ""
    }${failed.length ? `；跳过 ${failed.length} 条：${failed.join("；")}` : ""}`,
    tracks,
  };
}

/** 给 providersStatus 用：有没有登录凭据，能不能走登录那条路。 */
export function availability(cfg = {}) {
  const cred = loadCredential(cfg);
  return { ready: Boolean(cred.cookie), missing: cred.cookie ? [] : ["B站 登录凭据"], detail: cred.detail };
}
