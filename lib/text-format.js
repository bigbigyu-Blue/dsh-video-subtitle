/**
 * 字幕文本整理：把 B站 AI 字幕那种「一句一条、没有标点」的碎片，按时间空隙拼回
 * 通顺的句子，再补上标点，产出能直接读的文稿（实测 685 段、平均 12 字，逐条读像卡带）。
 *
 * 两条铁律，下面所有取舍都围着它们转：
 * 1. 只做「拼接」和「插入标点」，原文一个字都不改、不删、不译——字幕是别人说的话，
 *    改写等于伪造内容。所以加标点只有 insert，没有 replace。
 * 2. 合并要同时看时间空隙和长度：空隙大说明说话人确实停了（该断），长度太长说明
 *    一口气读不完（也该断）。只看一条会把整篇糊成一大坨。
 */

import { parseSrtBlocks, msToTimestamp } from "./srt.js";

const DEFAULTS = { maxGap: 0.6, maxChars: 42, paraGap: 1.6 };

/** 句末标点：上一段已经收尾了就不该再往后并，否则会拼出「今天很好。明天见」。 */
const SENTENCE_END_RE = /[。．.！!？?…][」』）)】》〉”’"\']*$/;

/** 话语标记：这些词常出现在分句开头，前面补一个逗号读起来才像人话。 */
const MARKERS = ["那么", "然后", "所以", "但是", "因为", "如果", "就是", "其实", "不过", "而且"];

/** 前一个字符已经是标点就不补逗号，避免出现「，，」「，。」这种叠标点。 */
const PUNCT_RE = /[，,。．.、；;：:！!？?…—～（(【《〈「『”’"\']/;

/** 收尾的引号/括号：句号要插在它们前面——「他说“你好。”」而不是「他说“你好”。」 */
const CLOSERS_RE = /[」』）)】》〉”’"\']+$/;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 中文直接连；两侧都是英文单词或数字时才补空格，否则 write + code 会粘成一个词。 */
function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b;
}

/**
 * 按文字本身判语种：拉丁字母比汉字/假名/谚文都多才算英文。
 * 不看谁传进来的语言标签——标签经常是错的，正文才可靠。
 */
function isLatinMajority(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (!latin) return false;
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return latin > cjk;
}

/** 把句子拆成「正文 + 收尾引号」，补标点时才知道该插在哪一位。 */
function splitTail(body) {
  const m = body.match(CLOSERS_RE);
  const closers = m ? m[0] : "";
  const core = closers ? body.slice(0, body.length - closers.length) : body;
  return { core, closers };
}

/** 中文：话语标记前插逗号。按下标扫一遍、只往中间插字符，原文顺序天然不变。 */
function insertMarkerCommas(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const marker = MARKERS.find((m) => text.startsWith(m, i));
    if (marker) {
      // 段落开头的标记词前面没东西，补了会变成「，然后」，所以 i > 0 才补
      if (i > 0 && !PUNCT_RE.test(text[i - 1])) out += "，";
      out += marker;
      i += marker.length;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/**
 * 按时间空隙把碎片拼成句子。
 * 三道闸门任一不满足就断开：单次空隙 > maxGap、合并后字数 > maxChars、累计停顿 > paraGap。
 * 累计停顿单独算，是因为连着好几个 0.5 秒的小空隙攒起来，其实已经是说话人喘口气了。
 */
export function assembleSentences(blocks, opts = {}) {
  const maxGap = num(opts.maxGap, DEFAULTS.maxGap);
  const maxChars = num(opts.maxChars, DEFAULTS.maxChars);
  const paraGap = num(opts.paraGap, DEFAULTS.paraGap);

  const out = [];
  let cur = null;
  let pause = 0; // 当前这句里已经攒下的静音秒数

  for (const raw of blocks ?? []) {
    const text = String(raw?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue; // 空段拼进去只会产生空行
    const start = Number(raw?.start) || 0;
    const end = Math.max(Number(raw?.end) || 0, start);

    if (cur) {
      // 时间轴偶尔重叠，重叠按 0 算，不能拿负数去冲抵后面的停顿
      const gap = Math.max(0, start - cur.end);
      const merged = joinText(cur.text, text);
      const nextPause = pause + gap;
      const canMerge =
        gap <= maxGap &&
        merged.length <= maxChars &&
        nextPause <= paraGap &&
        !SENTENCE_END_RE.test(cur.text);
      if (canMerge) {
        cur.text = merged;
        cur.end = Math.max(cur.end, end);
        pause = nextPause;
        continue;
      }
    }

    if (cur) out.push(cur);
    cur = { start, end, text };
    pause = 0;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 补标点。只允许「插」，绝不删除、替换、翻译或补词——原文必须逐字保持。
 * 中文补全角标点，英文补半角标点，句首大小写一律不动。
 */
export function addPunctuation(text, _opts = {}) {
  const src = String(text ?? "");
  if (!src.trim()) return src; // 空串、纯空白原样返回，不硬凑一个句号

  // 首尾空白没有任何信息，先摘掉再判句末，免得「你好 」变成「你好 。」
  const body = src.trim();

  if (isLatinMajority(body)) {
    const { core, closers } = splitTail(body);
    if (!core) return body;
    if (/[.!?…]$/.test(core)) return body; // 已有句末标点
    if (/[,;:]$/.test(core)) return body; // 已有别的标点，再补会变成「..., .」
    return core + "." + closers;
  }

  const { core, closers } = splitTail(body);
  if (!core) return body;

  const withCommas = insertMarkerCommas(core);
  if (/[。．.！!？?…]$/.test(withCommas)) return withCommas + closers; // 已经收尾
  if (/[，,、；;：:—～]$/.test(withCommas)) return withCommas + closers; // 「，。」不好看
  // 以「吗/呢/吧」收尾按问句处理，其余按陈述句
  return withCommas + (/[吗呢吧]$/.test(withCommas) ? "？" : "。") + closers;
}

/** 整理好的句子数组 → 标准 SRT 文本（序号从 1 开始，块间空一行，末尾一个换行）。 */
function blocksToSrt(sentences) {
  const lines = [];
  let i = 0;
  for (const s of sentences) {
    i += 1;
    lines.push(String(i));
    lines.push(`${msToTimestamp(s.start * 1000)} --> ${msToTimestamp(s.end * 1000)}`);
    lines.push(s.text);
    lines.push("");
  }
  return lines.length ? lines.join("\n") : "";
}

/** 句子数组 → 纯文稿：每段一行，段落之间空一行。 */
function sentencesToText(sentences) {
  return sentences.map((s) => s.text).join("\n\n");
}

/** 整篇走一遍：解析 → 合并 → 逐段补标点 → 重新排版。 */
function normalize(srt, opts) {
  const before = parseSrtBlocks(srt);
  const assembled = assembleSentences(before, opts);
  const sentences = assembled.map((s) => {
    const text = addPunctuation(s.text, opts);
    return { start: s.start, end: s.end, text };
  });
  const punctuated = sentences.filter((s, i) => s.text !== assembled[i].text).length;
  return { sentences, stats: { before: before.length, after: sentences.length, merged: before.length - sentences.length, punctuated } };
}

/**
 * 把 SRT 整理成「能读的版本」。
 * 返回的 srt 已重新编号，text 是纯文稿（段落之间空一行），
 * stats.merged 是被并掉的段数，stats.punctuated 是补上标点的段数。
 */
export function polishSrt(srt, opts = {}) {
  const { sentences, stats } = normalize(srt, opts);
  return { srt: blocksToSrt(sentences), text: sentencesToText(sentences), blocks: sentences, stats };
}

/** 只要纯文稿时走这里：同一套合并与补标点规则，输出每段一行、段落之间空一行。 */
export function toPlainText(blocks, opts = {}) {
  const sentences = assembleSentences(blocks, opts).map((s) => ({
    start: s.start,
    end: s.end,
    text: addPunctuation(s.text, opts),
  }));
  return sentencesToText(sentences);
}
