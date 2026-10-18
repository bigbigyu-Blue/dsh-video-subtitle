import test from "node:test";
import assert from "node:assert/strict";
import {
  msToTimestamp,
  clock,
  utterancesToSrt,
  parseSrtBlocks,
  timelineIssues,
  srtStats,
  readSlice,
  detectScriptLang,
  langSlug,
  langMatches,
} from "../lib/srt.js";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "第一句",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "第二句",
  "",
  "3",
  "0:0:8,20 --> 0:0:10,75",
  "第三句（第三方站的短写法）",
  "",
].join("\n");

test("时间戳与时钟格式", () => {
  assert.equal(msToTimestamp(3723456), "01:02:03,456");
  assert.equal(msToTimestamp(0), "00:00:00,000");
  assert.equal(clock(75), "01:15");
  assert.equal(clock(3675), "1:01:15");
});

test("识别引擎结果转字幕，空文本跳过", () => {
  const srt = utterancesToSrt([
    { start_time: 0, end_time: 1500, transcript: "你好" },
    { start_time: 1500, end_time: 2000, transcript: "   " },
    { start_time: 2000, end_time: 4000, transcript: "世界" },
  ]);
  const blocks = parseSrtBlocks(srt);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "你好");
  assert.equal(blocks[1].start, 2);
});

test("解析能容忍第三方站的短时间写法", () => {
  const blocks = parseSrtBlocks(SRT);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[2].start, 8.2);
  assert.equal(blocks[2].end, 10.75);
});

test("时间轴校验：正常通过，倒挂/倒退/超长都算坏", () => {
  assert.equal(timelineIssues(SRT, 60).ok, true);
  const reversed = "1\n00:00:10,000 --> 00:00:05,000\n倒挂\n";
  assert.equal(timelineIssues(reversed, 60).reason, "BAD_TIMELINE");
  const backward = [
    "1", "00:00:30,000 --> 00:00:31,000", "前面", "",
    "2", "00:00:05,000 --> 00:00:06,000", "倒退", "",
  ].join("\n");
  assert.equal(timelineIssues(backward, 60).reason, "BAD_TIMELINE");
  const overrun = "1\n00:00:50,000 --> 00:05:00,000\n超长\n";
  assert.equal(timelineIssues(overrun, 60).reason, "BAD_TIMELINE");
  assert.equal(timelineIssues("没有时间轴的一段话", 60).reason, "NO_TIMELINE");
});

test("统计：段数、总字数、首尾时间", () => {
  const s = srtStats(SRT);
  assert.equal(s.blocks, 3);
  assert.equal(s.firstStart, 1);
  assert.equal(s.lastEnd, 10.75);
  assert.ok(s.textChars > 0);
});

test("区间读取：正常区间、空区间、按上限截断", () => {
  const all = readSlice(SRT, { from: 0, to: 60, maxChars: 6000 });
  assert.equal(all.lines, 3);
  assert.match(all.text, /^\[00:01\] 第一句/);
  const mid = readSlice(SRT, { from: 4, to: 7, maxChars: 6000 });
  assert.equal(mid.lines, 1);
  assert.match(mid.text, /第二句/);
  const none = readSlice(SRT, { from: 100, to: 200, maxChars: 6000 });
  assert.equal(none.lines, 0);
  assert.equal(none.truncated, false);
});

test("超长单句不再整条丢弃，给前半截并标明截断", () => {
  const long = `1\n00:00:01,000 --> 00:00:20,000\n${"啊".repeat(400)}\n`;
  const r = readSlice(long, { from: 0, to: 60, maxChars: 200 });
  assert.equal(r.lines, 1);
  assert.equal(r.cutLine, true);
  assert.equal(r.truncated, true);
  assert.match(r.text, /本条过长，已截断/);
  assert.ok(r.chars <= 200, `字数 ${r.chars} 不该超过上限 200`);
});

test("按文字判断语种", () => {
  assert.equal(detectScriptLang("これは日本語のテストです"), "ja");
  assert.equal(detectScriptLang("이것은 한국어 테스트입니다"), "ko");
  assert.equal(detectScriptLang("这是一段中文测试文本内容"), "zh");
  assert.equal(detectScriptLang("this is an english sentence for testing"), "en");
  assert.equal(detectScriptLang("123"), null);
});

test("语言代码按整词比对，不被描述里的巧合字母带偏", () => {
  assert.equal(langSlug("ko"), "ko");
  assert.equal(langSlug("kor"), "ko");
  assert.equal(langSlug("zh-Hans"), "zh");
  assert.equal(langSlug("und", "SenseVoice"), "und", "SenseVoice 里含 en，不能被当成英语");
  assert.equal(langSlug("", "Korean"), "ko");
  assert.equal(langSlug("xx"), "xx");
  assert.equal(langSlug(""), "und");
});

test("语种匹配：代码一致算命中，描述写明也算", () => {
  assert.equal(langMatches("ko", "", "ko"), true);
  assert.equal(langMatches("kor", "", "ko"), true);
  assert.equal(langMatches("und", "中文（自动识别）", "zh"), true);
  assert.equal(langMatches("und", "SenseVoice", "en"), false);
  assert.equal(langMatches("ko", "Korean", "en"), false);
  assert.equal(langMatches("", "", "zh"), false);
});
