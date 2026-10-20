/**
 * SRT helpers: build from ASR utterances, parse (tolerant of the third-party
 * site's short form `0:0:2,5`), slice by time range for on-demand reading.
 */

const pad = (n, w) => String(n).padStart(w, "0");

export function msToTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(total % 1000, 3)}`;
}

export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${pad(m, 2)}:${pad(s, 2)}`;
}

function tsToSec(h, m, s, frac) {
  const scale = Math.pow(10, String(frac).length);
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(frac) / scale;
}

/** ASR utterances (start_time/end_time in ms, transcript) -> SRT text. */
export function utterancesToSrt(utterances) {
  const lines = [];
  let i = 0;
  for (const u of utterances ?? []) {
    const text = String(u?.transcript ?? u?.text ?? "").trim();
    if (!text) continue;
    i += 1;
    lines.push(String(i));
    lines.push(`${msToTimestamp(u.start_time)} --> ${msToTimestamp(u.end_time)}`);
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}

export function parseSrtBlocks(srt) {
  const blocks = [];
  for (const chunk of String(srt ?? "").replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const m = chunk.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const text = chunk.slice(m.index + m[0].length).replace(/^\s+/, "").trim();
    if (!text) continue;
    blocks.push({
      start: tsToSec(m[1], m[2], m[3], m[4]),
      end: tsToSec(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  return blocks;
}

/**
 * 时间轴是否可信。某些源会把整条时间轴写错位（视频只有 3 分半，某段却写成
 * 13 分 26 秒），文字完整但按时间读会读到错的时刻，必须当坏数据丢掉。
 * 判定三条：起止倒挂、段落起点倒退、时间戳超出视频总长。
 */
export function timelineIssues(srt, durationS) {
  const blocks = parseSrtBlocks(srt);
  if (!blocks.length) return { ok: false, reason: "NO_TIMELINE", detail: "解析不出任何带时间轴的字幕段" };
  const dur = Number(durationS);
  const limit = dur > 0 ? dur + Math.max(5, dur * 0.02) : null;
  const bad = [];
  let maxStart = null;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const where = `第 ${i + 1} 段`;
    if (b.end + 0.05 < b.start) {
      bad.push(`${where}起止倒挂（${clock(b.start)} → ${clock(b.end)}）`);
    } else if (maxStart != null && b.start + 10 < maxStart) {
      // 少量重叠是正常的（同一时刻上下两句），倒退回跳 10 秒以上才算坏
      bad.push(`${where}起点倒退（${clock(b.start)} 早于前面的 ${clock(maxStart)}）`);
    }
    if (limit != null && b.end > limit) {
      bad.push(`${where}超出视频时长（${clock(b.end)} > ${clock(dur)}）`);
    }
    maxStart = maxStart == null ? b.start : Math.max(maxStart, b.start);
    if (bad.length >= 3) break;
  }
  if (!bad.length) return { ok: true, reason: null, detail: "" };
  return { ok: false, reason: "BAD_TIMELINE", detail: bad.join("；") };
}

export function srtStats(srt) {
  const blocks = parseSrtBlocks(srt);
  return {
    blocks: blocks.length,
    chars: String(srt ?? "").length,
    textChars: blocks.reduce((n, b) => n + b.text.length, 0),
    firstStart: blocks.length ? blocks[0].start : null,
    lastEnd: blocks.length ? blocks[blocks.length - 1].end : null,
  };
}

/**
 * Read a time slice as compact `[MM:SS] text` lines, capped by maxChars so a
 * long transcript never floods the model context in one call.
 */
export function readSlice(srt, { from, to, maxChars = 6000 } = {}) {
  const blocks = parseSrtBlocks(srt);
  const inRange = blocks.filter(
    (b) => (from == null || b.end >= from) && (to == null || b.start <= to),
  );
  const lines = [];
  let chars = 0;
  let truncated = false;
  let cutLine = false;
  for (const b of inRange) {
    const line = `[${clock(b.start)}] ${b.text.replace(/\s*\n\s*/g, " ")}`;
    if (chars + line.length + 1 > maxChars) {
      // 预算装不下这一条：给出前半截并显式标注，绝不整条丢弃（否则调用方会以为该区间没有内容）
      const room = maxChars - chars - 1;
      const mark = " …（本条过长，已截断）";
      if (room > mark.length + 10) {
        lines.push(`${line.slice(0, room - mark.length)}${mark}`);
        chars = maxChars;
        cutLine = true;
      }
      truncated = true;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  return {
    text: lines.join("\n"),
    chars,
    lines: lines.length,
    matchedBlocks: inRange.length,
    totalBlocks: blocks.length,
    truncated,
    cutLine,
    range: { from: from ?? null, to: to ?? null },
  };
}

/**
 * 按文字本身判断语种：假名多 → 日语；谚文多 → 韩语；汉字多 → 中文；拉丁字母多 → 英语。
 * 用于「这个视频原文是什么语种」——标签（引擎给的）不可靠，正文才可靠。
 */
export function detectScriptLang(text) {
  const t = String(text ?? "");
  const kana = (t.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const hangul = (t.match(/[\uac00-\ud7af]/g) || []).length;
  const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (kana >= 5) return "ja";
  if (hangul >= 5) return "ko";
  if (han >= 10) return "zh";
  if (latin >= 20 && han < 5) return "en";
  return null;
}

/**
 * 语言别名表：语言代码、英文全名、常见中文写法。
 * 比对一律按「整词」，绝不按子串——描述里的 "SenseVoice" 含 en、"korean" 含 ko，
 * 按包含判断会把 und 轨误认成英语轨。
 */
const LANG_ALIASES = {
  zh: ["zh", "zho", "chi", "chs", "cht", "cmn", "chinese", "mandarin", "cantonese", "中", "汉", "漢", "国", "國", "普"],
  en: ["en", "eng", "english", "英"],
  ja: ["ja", "jp", "jpn", "japanese", "日"],
  ko: ["ko", "kor", "korean", "韩", "韓", "한"],
};

/** 切成可比对的整词：连续字母数字算一个词，每个汉字/谚文字各算一个词。 */
function langTokens(text) {
  const out = new Set();
  const t = String(text ?? "").toLowerCase();
  for (const m of t.matchAll(/[a-z0-9]+/g)) out.add(m[0]);
  for (const m of t.matchAll(/[\u3400-\u9fff\uac00-\ud7af]/g)) out.add(m[0]);
  return out;
}

/**
 * 语言代码/名称 → 统一的两字母代号（zh/en/ja/ko，认不出就返回原样的小写串）。
 * 只看语言代码本身：代码是准的，描述里可能含恰好长得像代码的词。
 */
export function langSlug(lang, langDesc = "") {
  const primary = String(lang ?? "").trim();
  if (primary) {
    const tokens = langTokens(primary);
    for (const [slug, aliases] of Object.entries(LANG_ALIASES)) {
      if (aliases.some((a) => tokens.has(a))) return slug;
    }
  }
  // 代码没认出来才看描述，同样按整词
  if (langDesc) {
    const tokens = langTokens(langDesc);
    for (const [slug, aliases] of Object.entries(LANG_ALIASES)) {
      if (aliases.some((a) => tokens.has(a))) return slug;
    }
  }
  const ascii = primary.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8);
  return ascii || "und";
}

/** 这条轨是不是要的那个语种。代码优先，描述里写明的语种也算。 */
export function langMatches(lang, langDesc, want) {
  const a = langSlug(lang, langDesc);
  const b = langSlug(want);
  if (a === b) return true;
  const aliases = LANG_ALIASES[b];
  if (!aliases) return false;
  const tokens = langTokens(langDesc);
  return aliases.some((x) => tokens.has(x));
}
