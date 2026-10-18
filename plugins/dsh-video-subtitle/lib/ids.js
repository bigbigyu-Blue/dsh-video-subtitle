/**
 * Video-id parsing and Bilibili metadata resolution.
 * bilibili（BV / av / b23.tv 短链 / ?p= 分P）+ youtube 识别（尚未接 provider）。
 */

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/;
const AV_RE = /\bav(\d{1,12})\b/i;
const YT_WATCH_RE = /(?:youtube\.com\/watch\?[^#\s]*\bv=)([A-Za-z0-9_-]{6,})/;
const YT_SHORT_RE = /youtu\.be\/([A-Za-z0-9_-]{6,})/;
const PAGE_RE = /[?&]p=(\d+)/;

const BILI_HOST_RE = /(^|\.)(bilibili\.com|b23\.tv|bilibili\.tv)/i;
const YT_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)/i;

/** @returns {{platform:'bilibili'|'youtube', raw:string, bvid?:string, aid?:number, videoId?:string, page?:number, short?:boolean}} */
export function parseVideoInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("empty video input");

  const page = Number(raw.match(PAGE_RE)?.[1] ?? 0) || undefined;
  const bv = raw.match(BV_RE);
  if (bv) return { platform: "bilibili", raw, bvid: bv[0], page };
  const av = raw.match(AV_RE);
  if (av && !raw.includes("/")) return { platform: "bilibili", raw, aid: Number(av[1]), page };

  let host = "";
  try {
    host = new URL(raw).host;
  } catch {
    /* not a URL — fall through */
  }
  if (BILI_HOST_RE.test(host)) {
    if (/(^|\.)b23\.tv/i.test(host)) return { platform: "bilibili", raw, short: true, page };
    const avUrl = raw.match(AV_RE); // 老式 av 编号链接（bilibili.com/video/av170001）只在B站域名下认，避免误吃别的网站地址
    if (avUrl) return { platform: "bilibili", raw, aid: Number(avUrl[1]), page };
    return { platform: "bilibili", raw, page };
  }
  if (YT_HOST_RE.test(host)) {
    const m = raw.match(YT_WATCH_RE) ?? raw.match(YT_SHORT_RE);
    if (!m) throw new Error(`无法从 YouTube 链接解析视频 ID: ${raw}`);
    return { platform: "youtube", raw, videoId: m[1] };
  }
  throw new Error(`无法识别的视频链接（支持 B站 BV 号 / av 号 / b23.tv 短链）: ${raw}`);
}

/** Follow a b23.tv short link to the final URL, then re-parse it. */
export async function resolveShortLink(parsed, { signal } = {}) {
  const res = await fetch(parsed.raw, {
    method: "GET",
    redirect: "follow",
    signal,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" },
  });
  const finalUrl = res.url || parsed.raw;
  return parseVideoInput(finalUrl);
}

/** Resolve bvid/aid + page into { bvid, aid, cid, title, durationS, page, pages }. */
export async function resolveBilibiliMeta(parsed, { signal, request }) {
  const query = parsed.bvid ? `bvid=${parsed.bvid}` : `aid=${parsed.aid}`;
  if (!parsed.bvid && !parsed.aid) throw new Error("bilibili 链接里没有 BV 号，且短链解析失败");
  const view = await request(`https://api.bilibili.com/x/web-interface/view?${query}`, {
    signal,
    headers: { Referer: "https://www.bilibili.com/" },
  });
  if (view?.code !== 0) throw new Error(`view 接口失败 code=${view?.code} ${view?.message ?? ""}`);
  const d = view.data ?? {};
  let cid = d.cid;
  let page = parsed.page ?? 1;
  let partTitle = "";
  if (page > 1 && Array.isArray(d.pages)) {
    const p = d.pages[page - 1];
    if (p) {
      cid = p.cid;
      partTitle = p.part ?? "";
    } else {
      page = 1;
    }
  }
  const title = partTitle ? `${d.title} - P${page} ${partTitle}` : d.title;
  return { bvid: d.bvid, aid: d.aid, cid, title, desc: d.desc ?? "", durationS: d.duration, page, pages: d.pages?.length ?? 1 };
}
