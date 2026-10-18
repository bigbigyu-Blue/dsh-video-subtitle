/**
 * Provider `native` — Bilibili's own subtitle tracks, anonymous `/x/player/v2`.
 * Zero third party, zero credentials. Low coverage (most videos gate their
 * AI subtitles behind login), but free and safe to try first.
 *
 * NOTE v0.1.0: the WBI-signed `/x/player/wbi/v2` fallback is NOT implemented;
 * this provider only calls the plain endpoint.
 */
import { utterancesToSrt } from "../srt.js";

export const id = "native";
const API = "https://api.bilibili.com";

export async function fetchSubtitles({ meta, ctx }) {
  const headers = { Referer: "https://www.bilibili.com/" };
  const data = await ctx.request(`${API}/x/player/v2?bvid=${meta.bvid}&cid=${meta.cid}`, { headers, signal: ctx.signal });
  if (data?.code !== 0) throw ctx.error(id, "NETWORK", `player/v2 code=${data?.code} ${data?.message ?? ""}`);

  const d = data.data ?? {};
  const list = d.subtitle?.subtitles ?? [];
  if (!list.length) {
    throw ctx.error(id, "NO_SUBTITLE", d.need_login_subtitle ? "need_login_subtitle=true（匿名无字幕轨）" : "无公开字幕轨");
  }

  const tracks = [];
  for (const t of list) {
    let url = t?.subtitle_url ?? "";
    if (!url) continue;
    if (url.startsWith("//")) url = "https:" + url;
    const body = await ctx.request(url, { headers, signal: ctx.signal });
    const items = body?.body ?? [];
    if (!items.length) continue;
    tracks.push({
      lang: t.lan ?? "",
      langDesc: t.lan_doc ?? t.lan ?? "",
      content: utterancesToSrt(
        items.map((b) => ({
          start_time: Number(b.from ?? 0) * 1000,
          end_time: Number(b.to ?? b.from ?? 0) * 1000,
          transcript: b.content,
        })),
      ),
      format: "srt",
    });
  }
  if (!tracks.length) throw ctx.error(id, "NO_SUBTITLE", "字幕轨存在但内容为空");
  return { source: id, tracks };
}
