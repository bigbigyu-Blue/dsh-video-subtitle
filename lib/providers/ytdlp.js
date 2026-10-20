/**
 * Provider ytdlp —— B站 以外的站，借现成的下载器去取站上自带的字幕。
 *
 * 分工很清楚：下载器装没装、怎么装，看 lib/ytdlp-env.js；怎么跑，看 lib/ytdlp.js；
 * 这里只回答「这条链接该不该用下载器、用哪一条字幕轨」。
 *
 * 规矩：
 *   1) B站 一律走官方接口，一步都不多做（下载器对 B站 也取不到东西）。
 *   2) 别的站先取站上自带的字幕：人工的优先，站上自动生成的其次。
 *   3) 站上现成字幕一条都没有，就如实说清，绝不去下音轨、也绝不编字幕。
 *   4) 一次只处理给的那一条链接，整张播放列表不展开。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { msToTimestamp, parseSrtBlocks } from "../srt.js";
import { ytdlpEnvPaths, ytdlpStatus } from "../ytdlp-env.js";
import { probe, downloadSubtitle } from "../ytdlp.js";

export const id = "ytdlp";

/** B站 的判断：平台字段已经写明，或者链接本身就在 B站 域名下。 */
const BILI_HOST_RE = /(^|\.)(bilibili\.com|b23\.tv|bilibili\.tv)/i;

function looksBilibili(meta) {
  if (String(meta?.platform ?? "") === "bilibili") return true;
  let host = "";
  try {
    host = new URL(String(meta?.raw ?? "")).host;
  } catch {
    return false;
  }
  return BILI_HOST_RE.test(host);
}

/** 下载器到底能不能用：缺什么就照实列出来，给 providersStatus 用。 */
export function availability(cfg = {}) {
  const st = ytdlpStatus(cfg);
  const missing = [];
  if (!st.ready) missing.push("下载器（yt-dlp）");
  return { ready: st.ready, missing, detail: st.detail };
}

/** 语种比对：只看代码本身，代码里带地区后缀时也认（en-US 对 en）。 */
function matches(track, want) {
  const a = String(track?.lang ?? "").toLowerCase();
  const b = String(want ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.split(/[-_]/)[0] === b.split(/[-_]/)[0];
}

/**
 * 挑一条轨：按 preferLang 的顺序找，人工字幕优先；人工里没有要的语种再看站上自动生成的；
 * 要的语种一条都没有，就用视频原文语种那条；再没有就取第一条。
 */
function pickLang(probeInfo, cfg, meta) {
  const prefer = (Array.isArray(cfg?.preferLang) ? cfg.preferLang : [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  const subs = probeInfo.subtitles ?? [];
  const autos = probeInfo.automaticCaptions ?? [];
  const hitIn = (list, want) => list.find((t) => matches(t, want));

  // 1) 先把人工字幕按首选语种挨个找一遍
  for (const want of prefer) {
    const manual = hitIn(subs, want);
    if (manual) return { track: manual, auto: false };
  }
  // 2) 人工里没有，再看站上自动生成的
  for (const want of prefer) {
    const auto = hitIn(autos, want);
    if (auto) return { track: auto, auto: true };
  }
  // 3) 要的语种都没有：用视频原文语种（清单里的 language 或外层传进来的 language）
  const original = String(probeInfo.language || meta?.language || "").trim();
  if (original) {
    const manual = hitIn(subs, original);
    if (manual) return { track: manual, auto: false };
    const auto = hitIn(autos, original);
    if (auto) return { track: auto, auto: true };
  }
  // 4) 还没有就取第一条：人工的排在前面
  if (subs.length) return { track: subs[0], auto: false };
  if (autos.length) return { track: autos[0], auto: true };
  return { track: null, auto: false };
}

/**
 * 建一个临时目录，照 whisper.js 里 makeTmpDir 的思路：
 * 先试插件自己那棵树，再试系统临时目录，最后靠 mkdtemp 造子目录。
 * 为什么要试好几个：这台机器上系统临时目录对受限进程不可写，只有插件这棵树放行。
 */
async function makeTmpDir(cfg = {}) {
  const roots = [...new Set([ytdlpEnvPaths(cfg).tmp, os.tmpdir()].filter(Boolean))];
  let lastErr = null;
  for (const root of roots) {
    try {
      await fs.mkdir(root, { recursive: true });
      return await fs.mkdtemp(path.join(root, "run-"));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("字幕临时目录都建不了（" + roots.join("、") + "）：" + (lastErr?.message ?? lastErr));
}

/**
 * 把下载器下出来的字幕洗一遍，交给上面的永远是标准 SRT：
 *   1) 去掉 <...> 尖括号标签（站上自动字幕里的 <c>、<00:00:01.234> 这类）与花括号标签（{\an8}）；
 *   2) 时间轴行一个字都不动；
 *   3) 删掉「与上一条文字完全相同」的重复条目（YouTube 自动字幕最常见）；
 *   4) 正文里的连续重复空行收成一行，整份文件是标准的「序号 / 时间轴 / 正文 / 空行」。
 */
function cleanSrt(text) {
  const blocks = parseSrtBlocks(text);
  const kept = [];
  let prevText = null;
  for (const b of blocks) {
    const body = String(b.text ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\{[^}]*\}/g, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    if (!body) continue;
    if (prevText !== null && body === prevText) continue;
    prevText = body;
    kept.push({ start: b.start, end: b.end, text: body });
  }
  const lines = [];
  kept.forEach((b, i) => {
    lines.push(String(i + 1));
    lines.push(msToTimestamp(b.start * 1000) + " --> " + msToTimestamp(b.end * 1000));
    lines.push(b.text);
    lines.push("");
  });
  return lines.join("\n");
}

/** 一句话说明这条轨是哪来的，界面和记录里直接用。 */
function noteOf(track, auto) {
  const who = auto ? "站上自动生成" : "站上人工上传";
  return "用下载器取的 " + (track.name || track.lang) + " 字幕（" + who + "）";
}

export async function fetchSubtitles({ meta, ctx }) {
  const cfg = ctx?.cfg ?? {};
  // 1) B站 一步都不多做：立刻退出，不碰下载器
  if (looksBilibili(meta)) {
    throw ctx.error(id, "UNSUPPORTED", "B站 走官方接口，不经过下载器");
  }

  // 2) 下载器没装：如实说清，名字写出来，告诉用户去哪装
  if (!ytdlpStatus(cfg).ready) {
    throw ctx.error(
      id,
      "DOWNLOADER_MISSING",
      "还没装下载器 yt-dlp：别的站要它才能取。到「设置 → 视频字幕」页的「下载器 yt-dlp」那张卡片点「一键安装」装一次就好。",
    );
  }

  const url = String(meta?.raw ?? meta?.url ?? "").trim();
  if (!url) throw ctx.error(id, "UNSUPPORTED_SITE", "没拿到视频链接，取不了");

  // 3) 取清单：外层取视频信息时已经问过一次（放在 meta.siteProbe 里），有就直接用，
  //    没有才自己问。真视频上问一次约三秒，问两遍等于白等六秒。
  let info = meta?.siteProbe ?? null;
  if (!info) {
    try {
      info = await probe({ url, cfg, signal: ctx.signal, timeoutMs: cfg.timeoutMs });
    } catch (e) {
      throw ctx.error(id, e?.code ?? "NETWORK", e?.detail || e?.message || String(e));
    }
  }
  if (!info.subtitles.length && !info.automaticCaptions.length) {
    throw ctx.error(
      id,
      "NO_SUBTITLE",
      "站上现成字幕一条都没有（人工与站上自动生成的都没有），这条只能靠本机转写",
    );
  }

  // 4) 选一条：人工优先，其次站上自动；要的语种没有就取原文语种，再没有取第一条
  const picked = pickLang(info, cfg, meta);
  const track = picked.track;
  const auto = picked.auto;
  if (!track) {
    throw ctx.error(id, "NO_SUBTITLE", "站上现成字幕一条都没有，取不到可用的语种");
  }

  // 5) 建临时目录，下载、读回来洗一遍；finally 里删干净
  let tmp = "";
  try {
    tmp = await makeTmpDir(cfg);
    let got;
    try {
      got = await downloadSubtitle({
        url,
        lang: track.lang,
        auto,
        dir: tmp,
        cfg,
        signal: ctx.signal,
        timeoutMs: cfg.timeoutMs,
      });
    } catch (e) {
      throw ctx.error(id, e?.code ?? "NETWORK", e?.detail || e?.message || String(e));
    }
    const raw = await fs.readFile(got.path, "utf8").catch(() => "");
    const content = cleanSrt(raw);
    if (!content.trim()) {
      throw ctx.error(id, "NO_SUBTITLE", "下载器下回了字幕文件，但里面没有可用的正文");
    }

    // 6) 一次只返回选中那一条轨
    return {
      source: id,
      note: noteOf(track, auto),
      tracks: [
        {
          lang: track.lang,
          langDesc: track.name || track.lang,
          ai: auto,
          content,
          format: "srt",
        },
      ],
    };
  } finally {
    // 收尾一定要真删干净：删失败也不许把已经取到的字幕丢掉，所以只吞掉删除本身的错
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
