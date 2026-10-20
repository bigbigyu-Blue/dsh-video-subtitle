import test from "node:test";
import assert from "node:assert/strict";
import { fetchSubtitles, availability } from "../lib/providers/native.js";
import { resetKeyCache } from "../lib/wbi.js";

const KEYS = {
  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
};
const META = { bvid: "BV1xx411c7mD", cid: 123456, title: "测试", desc: "", durationS: 120 };

const errors = (provider, reason, detail) => Object.assign(new Error(`[${provider}] ${reason}: ${detail}`), { provider, reason, detail });

/** 造一个按 URL 路由的假 request，记录每次请求以便断言「带没带 Cookie」。 */
function fakeRequest(routes) {
  const calls = [];
  const request = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers ?? {} });
    for (const [match, reply] of routes) {
      if (url.includes(match)) return typeof reply === "function" ? reply(url, opts) : reply;
    }
    throw new Error(`未预置的请求：${url}`);
  };
  return { request, calls };
}

const ctxWith = (request, cfg = { biliCookie: "SESSDATA=abc; bili_jct=xyz" }) => ({
  cfg,
  signal: undefined,
  request,
  error: errors,
  log: () => {},
});

test("公开字幕：匿名就能拿到，不发 Cookie，也不去取 WBI key", async () => {
  resetKeyCache();
  const { request, calls } = fakeRequest([
    ["/x/player/v2", { code: 0, data: { subtitle: { subtitles: [{ lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: "//aisubtitle.example/a.json", ai_type: 0 }] } } }],
    ["aisubtitle.example/a.json", { body: [{ from: 1, to: 2.5, content: "第一句" }] }],
  ]);
  const res = await fetchSubtitles({ meta: META, ctx: ctxWith(request) });
  assert.equal(res.tracks.length, 1);
  assert.equal(res.tracks[0].lang, "zh-CN");
  assert.match(res.tracks[0].content, /00:00:01,000 --> 00:00:02,500/);
  assert.match(res.tracks[0].content, /第一句/);
  const playerCall = calls.find((c) => c.url.includes("/x/player/v2"));
  assert.equal(playerCall.headers.Cookie, undefined, "匿名这一步绝不能带凭据");
  assert.ok(!calls.some((c) => c.url.includes("/x/web-interface/nav")), "拿到公开字幕就不该再多发 nav 请求");
});

test("匿名拿不到时改走登录 + WBI 签名，签名参数齐全", async () => {
  resetKeyCache();
  const { request, calls } = fakeRequest([
    ["/x/web-interface/nav", { code: 0, data: { isLogin: true, wbi_img: KEYS } }],
    ["/x/player/v2", { code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }],
    ["/x/player/wbi/v2", { code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "//ai.example/z.json", ai_type: 1 }] } } }],
    ["ai.example/z.json", { body: [{ from: 0, to: 1, content: "自动生成的一句" }] }],
  ]);
  const res = await fetchSubtitles({ meta: META, ctx: ctxWith(request) });
  assert.equal(res.tracks.length, 1);
  assert.match(res.note, /已用登录凭据/);
  assert.match(res.note, /AI 生成/);
  const signed = calls.find((c) => c.url.includes("/x/player/wbi/v2"));
  assert.match(signed.url, /[?&]bvid=BV1xx411c7mD/);
  assert.match(signed.url, /[?&]cid=123456/);
  assert.match(signed.url, /[?&]wts=\d+/, "必须带时间戳");
  assert.match(signed.url, /[?&]w_rid=[0-9a-f]{32}/, "必须带签名");
  assert.equal(signed.headers.Cookie, "SESSDATA=abc; bili_jct=xyz", "签名那一步必须带凭据");
});

test("没有登录凭据时如实说明是「需要登录」，不假装没有字幕", async () => {
  resetKeyCache();
  const { request } = fakeRequest([
    ["/x/player/v2", { code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }],
  ]);
  const ctx = ctxWith(request, { biliCookie: "", biliCredentialFile: "C:/definitely/not/here.json" });
  await assert.rejects(() => fetchSubtitles({ meta: META, ctx }), (e) => {
    assert.equal(e.reason, "NO_SUBTITLE");
    assert.match(e.detail, /需要登录/);
    return true;
  });
});

test("凭据过期时明确报 CREDENTIAL_EXPIRED，而不是笼统说没字幕", async () => {
  resetKeyCache();
  const { request } = fakeRequest([
    ["/x/web-interface/nav", { code: -101, data: { isLogin: false, wbi_img: KEYS } }],
    ["/x/player/v2", { code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }],
  ]);
  const ctx = ctxWith(request);
  await assert.rejects(() => fetchSubtitles({ meta: META, ctx }), (e) => {
    assert.equal(e.reason, "CREDENTIAL_EXPIRED");
    assert.doesNotMatch(e.detail, /SESSDATA=|bili_jct=/, "报错里绝不能出现凭据值");
    return true;
  });
});

test("只有元数据没有地址时，把「给的是哪几条轨」说出来", async () => {
  resetKeyCache();
  const { request } = fakeRequest([
    ["/x/web-interface/nav", { code: 0, data: { isLogin: true, wbi_img: KEYS } }],
    ["/x/player/v2", { code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }],
    ["/x/player/wbi/v2", { code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "" }] } } }],
  ]);
  const ctx = ctxWith(request);
  await assert.rejects(() => fetchSubtitles({ meta: META, ctx }), (e) => {
    assert.equal(e.reason, "NO_SUBTITLE");
    assert.match(e.detail, /中文（自动生成）/);
    assert.match(e.detail, /没有地址/);
    return true;
  });
});

test("多语言轨里坏了一条不影响其它条", async () => {
  resetKeyCache();
  const { request } = fakeRequest([
    ["/x/player/v2", {
      code: 0,
      data: { subtitle: { subtitles: [
        { lan: "ai-zh", lan_doc: "中文", subtitle_url: "//x.example/zh.json", ai_type: 1 },
        { lan: "ai-id", lan_doc: "印尼语", subtitle_url: "//x.example/id.json", ai_type: 1 },
      ] } },
    }],
    ["zh.json", { body: [{ from: 0, to: 1, content: "中文那句" }] }],
    ["id.json", () => { throw new Error("模拟下载失败"); }],
  ]);
  const res = await fetchSubtitles({ meta: META, ctx: ctxWith(request) });
  assert.equal(res.tracks.length, 1);
  assert.match(res.note, /跳过 1 条/);
});

test("可用性检查如实报告有没有凭据，且不泄露凭据内容", () => {
  const ok = availability({ biliCookie: "SESSDATA=secret-value" });
  assert.equal(ok.ready, true);
  const bad = availability({ biliCredentialFile: "C:/definitely/not/here.json" });
  assert.equal(bad.ready, false);
  assert.deepEqual(bad.missing, ["B站 登录凭据"]);
  assert.doesNotMatch(JSON.stringify(bad), /secret-value|SESSDATA/);
});
