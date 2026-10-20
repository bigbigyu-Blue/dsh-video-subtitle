import test from "node:test";
import assert from "node:assert/strict";
import { assembleSentences, addPunctuation, polishSrt, toPlainText } from "../lib/text-format.js";
import { parseSrtBlocks } from "../lib/srt.js";

/** 所有可能被插入或原文里就有的标点。用来证明「除了标点，一个字都没动」。 */
const PUNCT_ALL = /[，。．、；：！？…—～·「」『』（）【】《》〈〉“”‘’"',.;:!?()]/g;
const stripPunct = (s) => String(s ?? "").replace(PUNCT_ALL, "");

// 实测的 B站 AI 字幕形态：一句一条，没有标点
const FRAGMENTS = [
  { start: 0, end: 1.2, text: "今天我们来讲讲" },
  { start: 1.38, end: 2.6, text: "如何使用AI写代码" },
  { start: 2.75, end: 3.9, text: "装个codex或者是cloud code" },
];

test("停顿很小的无标点短句被并成一句，标点也补上了", () => {
  const sentences = assembleSentences(FRAGMENTS);
  assert.equal(sentences.length, 1, "三段间隔都在 0.6 秒内，应该并成一句");
  assert.equal(sentences[0].start, 0, "起点取第一段");
  assert.equal(sentences[0].end, 3.9, "终点取最后一段");
  assert.equal(sentences[0].text, "今天我们来讲讲如何使用AI写代码装个codex或者是cloud code");

  const out = polishSrt(
    [
      "1", "00:00:00,000 --> 00:00:01,200", "今天我们来讲讲", "",
      "2", "00:00:01,380 --> 00:00:02,600", "如何使用AI写代码", "",
    ].join("\n"),
  );
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].text, "今天我们来讲讲如何使用AI写代码。", "合并后要以句号收尾");
  assert.equal(out.stats.before, 2);
  assert.equal(out.stats.after, 1);
  assert.equal(out.stats.merged, 1);
  assert.equal(out.stats.punctuated, 1);
});

test("大停顿不会被并成一段", () => {
  const sentences = assembleSentences([
    { start: 0, end: 1, text: "第一句话说完了" },
    { start: 4, end: 5, text: "隔了三秒才接上" },
  ]);
  assert.equal(sentences.length, 2, "间隔 3 秒远超 maxGap 0.6，必须断开");
  assert.equal(sentences[0].text, "第一句话说完了");
  assert.equal(sentences[1].text, "隔了三秒才接上");
});

test("合并后字数超过上限就断开", () => {
  const long = "一二三四五六七八九十".repeat(3); // 30 字
  const sentences = assembleSentences(
    [
      { start: 0, end: 1, text: long },
      { start: 1.1, end: 2, text: long },
    ],
    { maxChars: 42 },
  );
  assert.equal(sentences.length, 2, "合起来 60 字超过 42，必须断开");
  assert.equal(sentences[0].text, long);

  // 上限放宽就能并起来，证明断开的原因确实是字数
  const merged = assembleSentences(
    [
      { start: 0, end: 1, text: long },
      { start: 1.1, end: 2, text: long },
    ],
    { maxChars: 80 },
  );
  assert.equal(merged.length, 1);
});

test("累计停顿超过 paraGap 时强制断开", () => {
  // 每个空隙 0.5 秒，单看都小于 maxGap，但攒到第五段已经静音 2 秒
  const blocks = [0, 1, 2, 3, 4].map((i) => ({
    start: i * 1.0,
    end: i * 1.0 + 0.5,
    text: "一二三四五"[i],
  }));
  const sentences = assembleSentences(blocks);
  assert.equal(sentences.length, 2, "累计静音超过 1.6 秒要断开");
  assert.equal(sentences[0].text, "一二三四");
  assert.equal(sentences[1].text, "五");
});

test("上一段已经以句末标点结尾就不再并", () => {
  const sentences = assembleSentences([
    { start: 0, end: 1, text: "今天先讲到这里。" },
    { start: 1.1, end: 2, text: "下面换个话题" },
  ]);
  assert.equal(sentences.length, 2, "已有句号收尾的段落不该往后粘");
});

test("加标点只插符号，去掉标点后文字完全不变", () => {
  const samples = [
    "今天我们来讲讲如何使用AI写代码",
    "我们先看一下然后就开始",
    "其实这个功能很简单",
    "那么问题就来了",
    "你确定要这样做吗",
    "不过我还是觉得有点复杂",
    "而且速度也快了很多",
    "他说这样写不够优雅",
    "这是一句已经带句号的话。",
    "hello world how are you",
    "the quick brown fox jumps",
  ];
  for (const src of samples) {
    const out = addPunctuation(src);
    assert.equal(stripPunct(out), stripPunct(src), `改动了原文：${src} -> ${out}`);
    assert.ok(out.length >= src.length, `不该删字：${src} -> ${out}`);
  }

  // 整篇走一遍同样成立：碎片拼接补标点之后，文字必须逐字一致
  const srt = FRAGMENTS.flatMap((b, i) => {
    const ts = (sec) => {
      const whole = String(Math.floor(sec));
      const ms = String(Math.round((sec - Math.floor(sec)) * 1000)).padStart(3, "0");
      return `00:00:${whole.padStart(2, "0")},${ms}`;
    };
    return [String(i + 1), `${ts(b.start)} --> ${ts(b.end)}`, b.text, ""];
  }).join("\n");
  const polished = polishSrt(srt);
  const before = parseSrtBlocks(srt).map((b) => b.text).join("");
  assert.equal(stripPunct(polished.text), stripPunct(before));
});

test("话语标记前补逗号，已有标点则不叠", () => {
  assert.equal(addPunctuation("我们先看一下然后就开始"), "我们先看一下，然后就开始。");
  assert.equal(addPunctuation("那么问题就来了"), "那么问题就来了。", "段首的标记词前面不补逗号");
  assert.equal(addPunctuation("其实，这个不用改"), "其实，这个不用改。", "已经紧跟逗号就不重复补");
  assert.equal(addPunctuation("因为所以"), "因为，所以。", "第二个标记词前面有字，照样补逗号");
  assert.equal(addPunctuation("然后我们就开始了"), "然后我们就开始了。", "段首就是标记词，前面没东西可补");
});

test("问句结尾补问号", () => {
  assert.equal(addPunctuation("你确定要这样做吗"), "你确定要这样做吗？");
  assert.equal(addPunctuation("这个我还没想好呢"), "这个我还没想好呢？");
  assert.equal(addPunctuation("那就这样吧"), "那就这样吧？");
});

test("已经是句号结尾的不重复加", () => {
  assert.equal(addPunctuation("今天先讲到这里。"), "今天先讲到这里。");
  assert.equal(addPunctuation("很好！"), "很好！");
  assert.equal(addPunctuation("真的吗？"), "真的吗？");
  const one = polishSrt("1\n00:00:00,000 --> 00:00:01,000\n今天先讲到这里。\n");
  assert.equal(one.blocks[0].text, "今天先讲到这里。");
});

test("英文文本补英文标点，不出现中文标点", () => {
  const out = addPunctuation("hello world how are you");
  assert.equal(out, "hello world how are you.");
  assert.equal(/[，。！？、；：（）【】]/.test(out), false, `不该出现中文标点：${out}`);
  assert.equal(out.endsWith("."), true);

  // 句首字母大小写一律不动
  assert.equal(addPunctuation("this is a test"), "this is a test.");
  assert.equal(addPunctuation("This is a Test"), "This is a Test.");

  // 已经是英文句号结尾的不重复补
  assert.equal(addPunctuation("already done."), "already done.");
});

test("英文单词之间合并时补空格，中文直接连", () => {
  const en = assembleSentences([
    { start: 0, end: 1, text: "hello" },
    { start: 1.1, end: 2, text: "world" },
  ]);
  assert.equal(en[0].text, "hello world");

  const zh = assembleSentences([
    { start: 0, end: 1, text: "你好" },
    { start: 1.1, end: 2, text: "世界" },
  ]);
  assert.equal(zh[0].text, "你好世界", "中文不加空格");
});

test("空输入和空字符串不报错", () => {
  assert.deepEqual(assembleSentences([]), []);
  assert.deepEqual(assembleSentences(null), []);
  assert.equal(addPunctuation(""), "");
  assert.equal(addPunctuation("   "), "   ");
  assert.equal(toPlainText([]), "");

  const empty = polishSrt("");
  assert.equal(empty.srt, "");
  assert.equal(empty.text, "");
  assert.deepEqual(empty.blocks, []);
  assert.deepEqual(empty.stats, { before: 0, after: 0, merged: 0, punctuated: 0 });

  // 空段不该拼进正文，也不该产生空行
  assert.deepEqual(assembleSentences([{ start: 0, end: 1, text: "  " }]), []);
});

test("polishSrt 重新编号从 1 开始，块之间空一行", () => {
  const srt = [
    "7", "00:00:00,000 --> 00:00:01,000", "第一段", "",
    "8", "00:00:05,000 --> 00:00:06,000", "第二段", "",
  ].join("\n");
  const out = polishSrt(srt);
  const lines = out.srt.split("\n");
  assert.equal(lines[0], "1", "序号从 1 开始重新编号");
  assert.equal(lines[1], "00:00:00,000 --> 00:00:01,000");
  assert.match(lines[2], /第一段。$/);
  assert.equal(lines[3], "");
  assert.equal(lines[4], "2");
  assert.equal(out.srt.endsWith("\n"), true, "末尾要有一个换行");

  // 文稿：段落之间空一行
  assert.equal(out.text, "第一段。\n\n第二段。");
  assert.equal(parseSrtBlocks(out.srt).length, 2, "整理后的字幕还能被解析回来");
});

test("toPlainText 每段一行、段落之间空一行", () => {
  const text = toPlainText([
    { start: 0, end: 1, text: "第一句" },
    { start: 5, end: 6, text: "第二句" },
  ]);
  assert.equal(text, "第一句。\n\n第二句。");
  assert.equal(toPlainText(FRAGMENTS), "今天我们来讲讲如何使用AI写代码装个codex或者是cloud code。");
});
