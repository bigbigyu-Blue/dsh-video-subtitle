/**
 * Video-id parsing and Bilibili metadata resolution.
 * bilibili（BV / av / b23.tv 短链 / ?p= 分P）+ 别的站（YouTube 各种写法，其余站原样留网址）。
 *
 * 别的站不在这里解析视频编号：那些站的解析规则全交给下载器，这里只负责「这是不是一个网址、
 * 是不是 B站」。认不出站点的网址也照样放行，让下载器去判断，报错才如实。
 */

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/;
const AV_RE = /\bav(\d{1,12})\b/i;
const YT_WATCH_RE = /(?:youtube\.com\/watch\?[^#\s]*\bv=)([A-Za-z0-9_-]{6,})/;
const YT_SHORT_RE = /youtu\.be\/([A-Za-z0-9_-]{6,})/;
// 手机分享出来的几种写法：/shorts/、/live/、/embed/
const YT_PATH_RE = /youtube(?:-nocookie)?\.com\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,})/;
const PAGE_RE = /[?&]p=(\d+)/;

const BILI_HOST_RE = /(^|\.)(bilibili\.com|b23\.tv|bilibili\.tv)/i;
const YT_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|m\.youtube\.com)/i;

/**
 * 解析结果。platform 只有三种：bilibili、youtube、other（别的站）。
 * 别的站只留 raw 网址与 host，视频标题、时长、原文语种由下载器问出来。
 * @returns {{platform:'bilibili'|'youtube'|'other', raw:string, host?:string, bvid?:string, aid?:number, videoId?:string, page?:number, short?:boolean}}
 */
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
    const m = raw.match(YT_WATCH_RE) ?? raw.match(YT_SHORT_RE) ?? raw.match(YT_PATH_RE) ?? null;
    // 播放列表链接（/playlist?list=...）不展开：用户定过一次只处理给的那一条
    if (!m && /[?&]list=/.test(raw)) throw new Error("这是整个播放列表的链接，一次只取一条视频。请在列表里打开要看的那一条，复制那条视频自己的网址");
    if (!m) throw new Error(`无法从 YouTube 链接解析视频 ID: ${raw}`);
    return { platform: "youtube", raw, host, videoId: m[1] };
  }
  if (host) return { platform: "other", raw, host };
  throw new Error(`无法识别的视频链接（要 B站 的 BV 号 / av 号 / b23.tv 短链，或者一条完整的视频网址）: ${raw}`);
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
