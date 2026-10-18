import test from "node:test";
import assert from "node:assert/strict";
import { parseVideoInput } from "../lib/ids.js";

test("BV 号：完整链接、裸号、带分P", () => {
  assert.equal(parseVideoInput("https://www.bilibili.com/video/BV1GJ411x7h7").bvid, "BV1GJ411x7h7");
  assert.equal(parseVideoInput("BV1GJ411x7h7").bvid, "BV1GJ411x7h7");
  const p = parseVideoInput("https://www.bilibili.com/video/BV1GJ411x7h7?p=3");
  assert.equal(p.bvid, "BV1GJ411x7h7");
  assert.equal(p.page, 3);
});

test("老式 av 编号：裸号与完整链接都认", () => {
  assert.equal(parseVideoInput("av170001").aid, 170001);
  assert.equal(parseVideoInput("https://www.bilibili.com/video/av170001").aid, 170001);
  const p = parseVideoInput("https://www.bilibili.com/video/av80433022?p=2");
  assert.equal(p.aid, 80433022);
  assert.equal(p.page, 2);
});

test("别站地址里的 av 字样不会被当成B站编号", () => {
  const yt = parseVideoInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ&av=123");
  assert.equal(yt.platform, "youtube");
  assert.equal(yt.videoId, "dQw4w9WgXcQ");
  assert.throws(() => parseVideoInput("https://example.com/video/av170001"), /无法识别的视频链接/);
});

test("b23 短链标记为 short", () => {
  const p = parseVideoInput("https://b23.tv/abcdefg");
  assert.equal(p.platform, "bilibili");
  assert.equal(p.short, true);
});

test("乱文字与非视频链接直接报错", () => {
  assert.throws(() => parseVideoInput("随便一段文字"), /无法识别的视频链接/);
  assert.throws(() => parseVideoInput(""), /empty video input/);
});
