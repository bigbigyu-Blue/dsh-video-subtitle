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
  // 别的站里带 av 字样的地址不认成 B站 编号，照常当「别的站」放行，交给下载器去判断
  const other = parseVideoInput("https://example.com/video/av170001");
  assert.equal(other.platform, "other");
  assert.equal(other.aid, undefined);
});

test("YouTube 的各种写法都认：看片、短链、手机分享、短视频、直播", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  ]) {
    const p = parseVideoInput(url);
    assert.equal(p.platform, "youtube", url);
    assert.equal(p.videoId, "dQw4w9WgXcQ", url);
  }
});

test("别的站一律原样留网址，平台记成 other", () => {
  for (const url of ["https://vimeo.com/123456", "https://www.douyin.com/video/7300000000000000000", "https://example.com/a/b?c=1"]) {
    const p = parseVideoInput(url);
    assert.equal(p.platform, "other", url);
    assert.equal(p.raw, url);
    assert.ok(p.host, "要留下主机名，报错与文件名都要用");
  }
});

test("整张播放列表的链接直接说清一次只取一条", () => {
  assert.throws(() => parseVideoInput("https://www.youtube.com/playlist?list=PLabc123"), /播放列表/);
  // 带 list 但也有 v 的单条链接照常认，只取那一条
  assert.equal(parseVideoInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123").videoId, "dQw4w9WgXcQ");
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
