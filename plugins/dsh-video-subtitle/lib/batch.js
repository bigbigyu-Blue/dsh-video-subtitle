/**
 * 批量取字幕：一串链接 → 展开目标（含分P）→ 逐个串行取 → 汇总。
 *
 * 为什么这么设计：
 * - 一条链接可能对应很多分P（合集、多集），只取第一条会漏内容，所以 parts=true
 *   时先问 view 接口要 data.pages，再按页展开成独立目标，每页单独走一遍取字幕。
 * - 批量里某一条失败（视频被删、没有字幕、网络抖动）不能拖累整批：失败只记进
 *   这一条的 error，循环继续跑下一条；只有外层 signal 取消才立即停。
 * - maxItems 是单次调用的条数上限，防止一次跑太久；但被截掉的条数必须如实返回，
 *   不能静默丢弃——用户有权知道还有多少条没取。
 * - request / fetchOne 都可注入，测试里传假的就能完全离线，不发一次真实请求。
 */
import { parseVideoInput, resolveShortLink } from "./ids.js";
import { subtitleFetch } from "./pipeline.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** 换行、逗号、空白都当分隔符：B站链接里不会有空格和逗号，切开是安全的。 */
const SPLIT_RE = /[\s,]+/;

const msgOf = (e) => e?.message ?? String(e);

/** 默认的 JSON 请求器；测试和工具层都可以换成自己的实现。 */
async function defaultRequest(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, ...(opts.headers ?? {}) },
    signal: opts.signal,
    redirect: "follow",
  });
  const json = await res.json().catch(() => null);
  if (json == null) throw new Error(`HTTP ${res.status} 响应不是 JSON: ${url}`);
  return json;
}

/**
 * 把用户给的批量清单归一成字符串数组。
 * 允许直接给数组，也允许给一整段文本（换行 / 逗号 / 空格分隔，方便从聊天记录里整段粘贴）。
 * 去空项、按「小写 + 去首尾空白」判重、保留用户原本的顺序（顺序就是取字幕的顺序）。
 * @param {string|string[]} spec
 * @returns {string[]}
 */
export function parseBatchSpec(spec) {
  const raw = Array.isArray(spec) ? spec : String(spec ?? "").split(SPLIT_RE);
  const out = [];
  const seen = new Set();
  for (const piece of raw) {
    const s = String(piece ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase(); // 同一个链接大小写不同只当一条，免得同一个视频被取两遍
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * 把输入清单展开成「一个视频/一个分P 一条」的目标列表。
 * @param {string|string[]} inputs 链接或 BV/av 号
 * @param {{request?: Function, signal?: AbortSignal, parts?: boolean}} [opts]
 * @returns {Promise<Array<{url: string, bvid?: string|null, page?: number, title?: string, skip?: string}>>}
 */
export async function expandTargets(inputs, { request, signal, parts = false } = {}) {
  const list = parseBatchSpec(inputs);
  const out = [];

  for (const input of list) {
    if (signal?.aborted) throw signal.reason ?? new Error("已取消");

    let parsed;
    try {
      parsed = parseVideoInput(input);
    } catch (e) {
      // 认不出的字符串不抛错：整批里有一条乱文字不该让其余链接全部作废
      out.push({ url: input, skip: msgOf(e) });
      continue;
    }

    if (parsed.short) {
      try {
        parsed = await resolveShortLink(parsed, { signal });
      } catch (e) {
        if (signal?.aborted) throw e;
        out.push({ url: input, skip: `b23 短链展开失败：${msgOf(e)}` });
        continue;
      }
    }

    if (parsed.platform !== "bilibili") {
      // 别的站（youtube 等）目前接不了，明确写清跳过原因，不假装取到了
      out.push({ url: parsed.raw, skip: `目前只支持 bilibili，收到的是 ${parsed.platform} 链接` });
      continue;
    }

    const page = parsed.page ?? 1; // 链接里没写 ?p= 就是第 1 个分P

    if (!parts) {
      out.push({ url: parsed.raw, bvid: parsed.bvid ?? null, page, title: "" });
      continue;
    }

    if (typeof request !== "function") {
      throw new Error("parts=true 需要一个可用的 request（用来查询分P列表）");
    }

    const query = parsed.bvid ? `bvid=${parsed.bvid}` : `aid=${parsed.aid}`;
    let view;
    try {
      view = await request(`https://api.bilibili.com/x/web-interface/view?${query}`, {
        signal,
        headers: { Referer: "https://www.bilibili.com/" },
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      // 查不到分P列表就不展开：硬按单条取会漏掉后面的分P，还让用户以为已经取全了
      out.push({ url: parsed.raw, skip: `分P列表查询失败，没法确认共有几个分P：${msgOf(e)}` });
      continue;
    }

    const data = view?.data ?? {};
    const bvid = data.bvid ?? parsed.bvid ?? null;
    const pages = (Array.isArray(data.pages) ? data.pages : [])
      .filter((p) => p && Number(p.page) > 0)
      .sort((a, b) => Number(a.page) - Number(b.page));
    if (view?.code !== 0 || !bvid || !pages.length) {
      out.push({
        url: parsed.raw,
        skip: `分P列表查询失败：code=${view?.code ?? "?"} ${view?.message ?? ""}`.trim(),
      });
      continue;
    }

    const baseTitle = String(data.title ?? "");
    // 只有一个分P时这里天然只出来一条，不会重复
    for (const p of pages) {
      const n = Number(p.page);
      const part = String(p.part ?? "").trim();
      out.push({
        url: `https://www.bilibili.com/video/${bvid}?p=${n}`,
        bvid,
        page: n,
        title: part ? `${baseTitle} - P${n} ${part}` : `${baseTitle} - P${n}`,
      });
    }
  }

  return out;
}

/**
 * 把 pipeline 的失败原因翻译成一句人话，写进这一条的 error。
 * 优先用覆盖面不足这种最具体的原因，其次才列各源的报错。
 */
function failReason(res) {
  if (!res) return "取字幕没有返回结果";
  if (res.partial) return `只覆盖 ${res.coveragePct ?? "?"}%，未达可用线`;
  const tries = (Array.isArray(res.attempts) ? res.attempts : []).filter(
    (a) => a && a.result !== "OK" && a.result !== "CACHED",
  );
  if (tries.length) {
    return tries.map((a) => `${a.provider ?? "?"}: ${a.result ?? "?"}${a.detail ? ` ${a.detail}` : ""}`).join("；");
  }
  return "所有字幕源都没有取到可用字幕";
}

/** 只保留汇报需要的轨字段，不要把整段字幕正文塞进批量结果里。 */
function slimTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : []).map((t) => ({
    path: t?.path ?? null,
    language: t?.language ?? t?.langDesc ?? t?.lang ?? null,
    chars: Number(t?.chars ?? 0),
    blocks: Number(t?.blocks ?? 0),
    coveragePct: t?.coveragePct ?? null,
  }));
}

/**
 * 批量取字幕。
 * @param {object} args
 * @param {string|string[]} args.urls 必填
 * @param {boolean} [args.parts=false]
 * @param {string} [args.lang]
 * @param {string} [args.dir]
 * @param {boolean} [args.force=false]
 * @param {object} [args.cfg]
 * @param {AbortSignal} [args.signal]
 * @param {(msg: string) => void} [args.log]
 * @param {string} [args.workspaceRoot]
 * @param {number} [args.maxItems=20]
 * @param {Function} [args.fetchOne] 默认 pipeline 的 subtitleFetch
 * @param {Function} [args.request] 查询分P列表用，默认走 fetch
 */
export async function batchFetch(args = {}) {
  const {
    urls,
    parts = false,
    lang,
    dir,
    force = false,
    cfg = {},
    signal,
    log = () => {},
    workspaceRoot = "",
    maxItems = 20,
    fetchOne = subtitleFetch,
    request = defaultRequest,
  } = args ?? {};

  const startedAt = Date.now();
  const list = parseBatchSpec(urls);
  if (!list.length) throw new Error("urls 必填：请传入一个视频链接字符串或链接数组");

  let targets;
  try {
    targets = await expandTargets(list, { request, signal, parts });
  } catch (e) {
    if (signal?.aborted) {
      // 还没开始取就被取消了，直接如实返回空结果
      return {
        ok: false,
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        truncated: 0,
        aborted: true,
        items: [],
        totalChars: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }
    throw e;
  }

  const cap = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0 ? Math.trunc(Number(maxItems)) : 20;
  const total = targets.length;
  const kept = targets.slice(0, cap);
  const truncated = total - kept.length;
  if (truncated > 0) {
    log(`[videosub] 本次最多取 ${cap} 条，还有 ${truncated} 条没取（清单共 ${total} 条）`);
  }

  const items = [];
  let failedCount = 0;
  let skippedCount = 0;
  let totalChars = 0;
  let aborted = false;

  for (let i = 0; i < kept.length; i += 1) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const target = kept[i];

    if (target.skip) {
      items.push({
        url: target.url,
        bvid: target.bvid ?? null,
        page: target.page ?? null,
        title: target.title ?? "",
        ok: false,
        cached: false,
        source: null,
        coveragePct: null,
        chars: 0,
        blocks: 0,
        tracks: [],
        error: target.skip,
        elapsedMs: 0,
      });
      skippedCount += 1;
      continue;
    }

    const t0 = Date.now();
    log(`[videosub] 批量 ${i + 1}/${kept.length}：${target.url}`);
    let res;
    try {
      res = await fetchOne({ url: target.url, lang, dir, force, cfg, signal, workspaceRoot, log });
    } catch (e) {
      if (signal?.aborted) {
        // 外层取消：这一条不算失败，直接停，前面的结果照常返回
        aborted = true;
        break;
      }
      items.push({
        url: target.url,
        bvid: target.bvid ?? null,
        page: target.page ?? null,
        title: target.title ?? "",
        ok: false,
        cached: false,
        source: null,
        coveragePct: null,
        chars: 0,
        blocks: 0,
        tracks: [],
        error: msgOf(e),
        elapsedMs: Date.now() - t0,
      });
      failedCount += 1;
      continue;
    }

    const ok = res?.ok === true;
    const rawTracks = Array.isArray(res?.tracks) ? res.tracks : [];
    const tracks = slimTracks(rawTracks);
    const picked = rawTracks.find((t) => t?.picked === true) ?? rawTracks[0] ?? null;
    const chars = Number(picked?.chars ?? 0);
    const blocks = Number(picked?.blocks ?? 0);
    if (ok && chars > 0) totalChars += chars;
    if (!ok) failedCount += 1;

    items.push({
      url: target.url,
      bvid: target.bvid ?? res?.bvid ?? null,
      page: target.page ?? res?.page ?? null,
      title: target.title || res?.title || "",
      ok,
      cached: res?.cached === true,
      source: res?.source ?? null,
      coveragePct: picked?.coveragePct ?? res?.coveragePct ?? null,
      chars,
      blocks,
      tracks,
      error: ok ? null : failReason(res),
      elapsedMs: Date.now() - t0,
    });
  }

  return {
    ok: items.some((it) => it.ok),
    total,
    done: items.length - skippedCount, // 真正跑过取字幕的条数（跳过项不算）
    failed: failedCount,
    skipped: skippedCount,
    truncated,
    aborted,
    items,
    totalChars,
    elapsedMs: Date.now() - startedAt,
  };
}
