import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError, nodeExe, ytdlpExe, probe, downloadSubtitle, downloadAudio } from "../lib/ytdlp.js";
import { availability, fetchSubtitles } from "../lib/providers/ytdlp.js";

// 所有临时目录都开在仓库里面的 test 目录下，不走系统临时目录，收尾整个删掉。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_BASE = path.join(HERE, ".tmp-ytdlp-" + process.pid);
let tmpSeq = 0;

function tmpDir(name) {
  tmpSeq += 1;
  const dir = path.join(TMP_BASE, name + "-" + tmpSeq);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let savedHome = null;

before(() => {
  // 下载器装没装、临时目录在哪都听 DSH_HOME，测试一律指到仓库里的临时目录，
  // 绝不去碰真实的 DSH_HOME。
  savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(TMP_BASE, "home");
});

after(async () => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  await fs.rm(TMP_BASE, { recursive: true, force: true });
});

/** 假下载器本体：只有「大于 5 兆」才算装好，这里造 6 兆，运行由假的子进程负责。 */
const BIG_BYTES = 6 * 1024 * 1024;

async function fakeExe(bytes = BIG_BYTES) {
  const dir = tmpDir("exe");
  const file = path.join(dir, "yt-dlp.exe");
  const fh = await fs.open(file, "w");
  try {
    await fh.truncate(bytes);
  } finally {
    await fh.close();
  }
  return file;
}

/**
 * 假的下载器脚本：拿 node 当那个 exe，按参数决定干什么。
 * 三种活：取清单（--dump-single-json）、下字幕（--write-subs/--write-auto-subs）、下音轨（-f）。
 * 链接里带 unsupported 的，就当站点不支持，报那句真实报错原文然后退出 1。
 */
const SCRIPT = String.raw`import path from "node:path";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const url = args[args.length - 1] || "";

if (url.includes("unsupported")) {
  process.stderr.write("ERROR: Unsupported URL: " + url + "\n");
  process.exit(1);
}

// 这台机器上真出现过：下载器起不来，报「建不了临时目录」，被当成网络问题
if (url.includes("notmpdir")) {
  process.stderr.write("[PYI-15480:ERROR] Could not create temporary directory!\n");
  process.exit(1);
}

const id = (url.match(/[A-Za-z0-9_-]{6,}/g) || ["abc123"])[0].slice(0, 11) || "abc123";

if (args.includes("--dump-single-json")) {
  const info = {
    id,
    title: "一个测试视频",
    duration: 12.5,
    language: url.includes("nolang") ? "" : "en",
    extractor_key: "Youtube",
    subtitles: url.includes("nosub")
      ? {}
      : { "zh-CN": [{ ext: "vtt", name: "中文（人工）" }], en: [{ ext: "srt", name: "English" }] },
    automatic_captions: url.includes("nosub")
      ? {}
      : { ja: [{ ext: "vtt", name: "日本語（自动生成）" }], en: [{ ext: "vtt", name: "English (auto)" }] },
  };
  process.stdout.write(JSON.stringify(info) + "\n");
  process.stderr.write("[youtube] " + id + ": Downloading webpage\n");
  process.exit(0);
}

const outIdx = args.indexOf("-o");
const template = outIdx >= 0 ? args[outIdx + 1] : "";
const fill = (ext) => template.split("%(id)s").join(id).split("%(ext)s").join(ext);

if (args.includes("--write-subs") || args.includes("--write-auto-subs")) {
  const langIdx = args.indexOf("--sub-langs");
  const lang = langIdx >= 0 ? args[langIdx + 1] : "en";
  const file = template ? fill("srt").split(".en.srt").join("." + lang + ".srt") : path.join(".", id + "." + lang + ".srt");
  if (url.includes("nolangsrt")) {
    process.stderr.write("ERROR: There are no subtitles for the requested languages\n");
    process.exit(1);
  }
  writeFileSync(
    file,
    "1\n00:00:01,000 --> 00:00:02,000\n<c>hello</c> {\\\\an8}world\n\n" +
      "2\n00:00:02,000 --> 00:00:03,000\nhello world\n\n" +
      "3\n00:00:03,000 --> 00:00:04,000\n<00:00:03.500>third line\n\n",
    "utf8",
  );
  process.stdout.write("[youtube] " + id + ": Downloading webpage\n");
  process.exit(0);
}

if (args.includes("-f")) {
  const file = template ? fill("m4a") : path.join(".", id + ".m4a");
  writeFileSync(file, "fake audio", "utf8");
  process.stdout.write("[youtube] " + id + ": Downloading webpage\n");
  process.exit(0);
}

process.stderr.write("ERROR: nothing to do\n");
process.exit(1);
`;

/** 把假脚本写到临时目录里，返回脚本路径。 */
function writeScript() {
  const dir = tmpDir("script");
  const file = path.join(dir, "fake-ytdlp.mjs");
  writeFileSync(file, SCRIPT, "utf8");
  return file;
}

/**
 * 假的子进程：拿 node 跑假脚本，把下载器参数原样接在脚本后面。
 * 记下每次调用，测试拿它检查参数对不对。这样不用真下载，也真的跑了一次子进程。
 */
function fakeSpawn(scriptPath) {
  const calls = [];
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    return spawn(process.execPath, [scriptPath, ...args], opts);
  };
  spawnFn.calls = calls;
  return spawnFn;
}

/** 假 ctx：只实现 provider 会用到的几样，error 造出来的错误带 reason 与 detail。 */
function makeCtx(cfg, extra = {}) {
  return {
    cfg,
    signal: undefined,
    log: () => {},
    error: (provider, reason, detail) => {
      const e = new Error("[" + provider + "] " + reason + ": " + detail);
      e.provider = provider;
      e.reason = reason;
      e.detail = detail;
      return e;
    },
    ...extra,
  };
}

test("classifyError：站点不支持认成 UNSUPPORTED_SITE", () => {
  const r = classifyError("ERROR: Unsupported URL: https://weird.example/watch/1");
  assert.equal(r.code, "UNSUPPORTED_SITE");
  assert.match(r.detail, /Unsupported URL/);
});

test("classifyError：要登录归到 UNSUPPORTED_SITE，但话里要说清是要登录", () => {
  // 错误码只有九类，没有「要登录」这一条：对用户来说都是这条网址这里取不到
  const r = classifyError("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser");
  assert.equal(r.code, "UNSUPPORTED_SITE");
  assert.match(r.detail, /要登录/);
  assert.match(r.detail, /不替你登录/);
  assert.match(r.detail, /Sign in to confirm/);
  // 私享视频、会员专享同样归这一条
  assert.equal(classifyError("ERROR: Private video. Sign in if you've been granted access").code, "UNSUPPORTED_SITE");
  assert.equal(classifyError("ERROR: This video is members-only").code, "UNSUPPORTED_SITE");
});

test("classifyError：网址不是一个视频页（404）认成网址不支持，不报成网络故障", () => {
  const r = classifyError("ERROR: [generic] not-a-video: Unable to download webpage: HTTP Error 404: Not Found");
  assert.equal(r.code, "UNSUPPORTED_SITE");
});

test("classifyError：每种错误都说一句中文，后面才跟下载器原话", () => {
  assert.match(classifyError("ERROR: Unsupported URL: https://x/").detail, /认不出/);
  assert.match(classifyError("ERROR: HTTP Error 503: Service Unavailable").detail, /连不上/);
  assert.match(classifyError("WARNING: There are no subtitles for the requested languages").detail, /站上没有/);
});

test("classifyError：下载器建不了临时目录时，别说成网络故障", () => {
  // 这台机器上真发生过：临时目录写不进去，下载器直接退出，原文只有一行 PYI 报错。
  // 归成网络问题会让人一直重试一条其实没问题的网。
  const r = classifyError("[PYI-15480:ERROR] Could not create temporary directory!");
  assert.notEqual(r.code, "NETWORK");
  assert.match(r.detail, /临时目录|下载器/, r.detail);
});

test("classifyError：没字幕认成 NO_SUBTITLE", () => {
  const r = classifyError("WARNING: There are no subtitles for the requested languages");
  assert.equal(r.code, "NO_SUBTITLE");
});

test("classifyError：连不上认成 NETWORK，认不出的也按 NETWORK 兜底", () => {
  assert.equal(classifyError("ERROR: Unable to download webpage: <urlopen error [Errno 11002] getaddrinfo failed>").code, "NETWORK");
  assert.equal(classifyError("ERROR: HTTP Error 503: Service Unavailable").code, "NETWORK");
  const odd = classifyError("ERROR: 说不清是什么问题");
  assert.equal(odd.code, "NETWORK");
  assert.match(odd.detail, /说不清是什么问题/, "认不出也要带上下载器原文");
});

test("classifyError：detail 里的用户目录与带查询串的地址要抹掉", () => {
  const r = classifyError("ERROR: 存到了 C:\\Users\\someone\\Desktop\\x.srt 和 https://h.example/a?token=SECRET");
  assert.doesNotMatch(r.detail, /someone/);
  assert.doesNotMatch(r.detail, /SECRET/);
  assert.match(r.detail, /<用户目录>/);
});

test("nodeExe：找到的要么是空，要么是真实存在的 node 程序", () => {
  const found = nodeExe();
  if (found === null) return;
  assert.ok(existsSync(found), "返回的路径必须真的存在");
  assert.match(path.basename(found).toLowerCase(), /^node(\.exe)?$/);
});

test("ytdlpExe：配置里指了就用配置的，否则用插件自己装的那份", async () => {
  const mine = await fakeExe();
  assert.equal(ytdlpExe({ ytdlpPath: mine }), mine);
  const def = ytdlpExe({});
  assert.ok(def.endsWith(path.join("bin", "yt-dlp.exe")), "默认要落在插件自己的 bin 里");
});

test("probe：清单解析成统一的轨列表，人工与自动分开", async () => {
  const script = writeScript();
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: fakeSpawn(script) };
  const r = await probe({ url: "https://example.com/watch?v=abc12345678", cfg });
  assert.equal(r.ok, true);
  assert.equal(r.language, "en");
  assert.equal(r.extractor, "Youtube");
  assert.deepEqual(r.subtitles.map((t) => t.lang), ["zh-CN", "en"]);
  assert.deepEqual(r.subtitles.map((t) => t.auto), [false, false]);
  assert.deepEqual(r.automaticCaptions.map((t) => t.auto), [true, true]);
  assert.deepEqual(r.subtitles.find((t) => t.lang === "zh-CN").formats, ["vtt"]);
  // 语种名尾巴上的「（人工）」这类备注要抹掉
  assert.equal(r.subtitles.find((t) => t.lang === "zh-CN").name, "中文");
});

test("probe：站点不支持时抛错，错误码与原文都带上", async () => {
  const script = writeScript();
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: fakeSpawn(script) };
  await assert.rejects(
    () => probe({ url: "https://unsupported.example/v/1", cfg }),
    (e) => e.code === "UNSUPPORTED_SITE" && /Unsupported URL/.test(e.detail),
  );
});

test("downloadSubtitle：参数齐全，下回来的 srt 路径对得上", async () => {
  const script = writeScript();
  const spawnFn = fakeSpawn(script);
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: spawnFn };
  const dir = tmpDir("subs");
  const url = "https://example.com/watch?v=abc12345678";
  const r = await downloadSubtitle({ url, lang: "zh-CN", dir, cfg });
  assert.equal(r.format, "srt");
  assert.ok(existsSync(r.path), "返回的路径必须真的存在");
  assert.ok(r.path.toLowerCase().endsWith(".srt"));

  const args = spawnFn.calls[0].args;
  assert.deepEqual(args.slice(0, 2).length, 2);
  assert.ok(args.includes("--write-subs"), "人工字幕要用 --write-subs");
  assert.ok(!args.includes("--write-auto-subs"));
  assert.ok(args.includes("--no-playlist"), "整张播放列表不展开");
  assert.ok(args.includes("--no-warnings"));
  assert.equal(args[args.indexOf("--sub-langs") + 1], "zh-CN");
  assert.equal(args[args.indexOf("--sub-format") + 1], "srt");
  assert.equal(args[args.indexOf("--convert-subs") + 1], "srt");
  // 链接原样作为一个参数传进去，不拼字符串、不加引号
  assert.equal(args[args.length - 1], url);
  assert.equal(args[args.length - 2], "--");
  // 子进程统一 windowsHide，临时目录指到插件自己的位置
  assert.equal(spawnFn.calls[0].opts.windowsHide, true);
  const tmpInside = path.join(TMP_BASE, "home", "video-subtitle", "ytdlp", "tmp");
  assert.equal(spawnFn.calls[0].opts.env.TEMP, tmpInside);
  assert.equal(spawnFn.calls[0].opts.env.TMP, tmpInside);
});

test("downloadSubtitle：自动字幕用 --write-auto-subs", async () => {
  const script = writeScript();
  const spawnFn = fakeSpawn(script);
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: spawnFn };
  await downloadSubtitle({ url: "https://example.com/watch?v=abc12345678", lang: "ja", auto: true, dir: tmpDir("auto"), cfg });
  const args = spawnFn.calls[0].args;
  assert.ok(args.includes("--write-auto-subs"));
  assert.ok(!args.includes("--write-subs"));
  assert.equal(args[args.indexOf("--sub-langs") + 1], "ja");
});

test("downloadSubtitle：站点不支持时抛 UNSUPPORTED_SITE", async () => {
  const script = writeScript();
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: fakeSpawn(script) };
  await assert.rejects(
    () => downloadSubtitle({ url: "https://unsupported.example/v/2", lang: "en", dir: tmpDir("bad"), cfg }),
    (e) => e.code === "UNSUPPORTED_SITE",
  );
});

test("downloadSubtitle：站上没有这个语种的字幕时抛 NO_SUBTITLE", async () => {
  const script = writeScript();
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: fakeSpawn(script) };
  await assert.rejects(
    () => downloadSubtitle({ url: "https://example.com/nolangsrt/v", lang: "en", dir: tmpDir("nosub"), cfg }),
    (e) => e.code === "NO_SUBTITLE",
  );
});

test("downloadAudio：下最好的音轨，返回路径与主机名", async () => {
  const script = writeScript();
  const spawnFn = fakeSpawn(script);
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: spawnFn };
  const dir = tmpDir("audio");
  const r = await downloadAudio({ url: "https://example.com/watch?v=abc12345678", dir, cfg });
  assert.ok(existsSync(r.path));
  assert.equal(r.host, "example.com");
  const args = spawnFn.calls[0].args;
  assert.equal(args[args.indexOf("-f") + 1], "bestaudio/best");
  assert.ok(args.includes("--no-playlist"));
});

test("取消：已经取消过的信号不会真去起子进程", async () => {
  const script = writeScript();
  const spawnFn = fakeSpawn(script);
  const cfg = { ytdlpPath: "C:\\假的\\yt-dlp.exe", ytdlpSpawnFn: spawnFn };
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => probe({ url: "https://example.com/watch?v=abc12345678", cfg, signal: ac.signal }));
  assert.equal(spawnFn.calls.length, 0);
});

test("availability：下载器没装就说缺下载器，装好了就说能用", async () => {
  const bad = availability({ ytdlpPath: path.join(TMP_BASE, "没有这个文件.exe") });
  assert.equal(bad.ready, false);
  assert.deepEqual(bad.missing, ["下载器（yt-dlp）"]);
  assert.match(bad.detail, /还没装/);

  const ok = availability({ ytdlpPath: await fakeExe() });
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.missing, []);
});

test("fetchSubtitles：B站 链接立刻抛 UNSUPPORTED，一步都不多做", async () => {
  const spawnFn = fakeSpawn(writeScript());
  // 故意不给装下载器：要是顺序错了，先报的会是 DOWNLOADER_MISSING
  const cfg = { ytdlpPath: "", ytdlpSpawnFn: spawnFn };
  await assert.rejects(
    () => fetchSubtitles({ meta: { platform: "bilibili", raw: "https://www.bilibili.com/video/BV1xx411c7mD" }, ctx: makeCtx(cfg) }),
    (e) => e.reason === "UNSUPPORTED" && /B站/.test(e.detail),
  );
  assert.equal(spawnFn.calls.length, 0, "B站 不该碰下载器");
});

test("fetchSubtitles：下载器没装就抛 DOWNLOADER_MISSING，并告诉去哪装", async () => {
  const cfg = { ytdlpPath: "", ytdlpSpawnFn: fakeSpawn(writeScript()) };
  await assert.rejects(
    () => fetchSubtitles({ meta: { platform: "youtube", raw: "https://example.com/watch?v=abc12345678" }, ctx: makeCtx(cfg) }),
    (e) => e.reason === "DOWNLOADER_MISSING" && /设置/.test(e.detail) && /一键安装/.test(e.detail),
  );
});

test("fetchSubtitles：站上一条字幕都没有就抛 NO_SUBTITLE", async () => {
  const cfg = { ytdlpPath: await fakeExe(), ytdlpSpawnFn: fakeSpawn(writeScript()) };
  await assert.rejects(
    () => fetchSubtitles({ meta: { platform: "youtube", raw: "https://example.com/nosub/v" }, ctx: makeCtx(cfg) }),
    (e) => e.reason === "NO_SUBTITLE" && /一条都没有/.test(e.detail),
  );
});

test("fetchSubtitles：人工字幕优先，洗完之后是干净的标准 SRT", async () => {
  const cfg = { ytdlpPath: await fakeExe(), preferLang: ["zh"], ytdlpSpawnFn: fakeSpawn(writeScript()) };
  const r = await fetchSubtitles({
    meta: { platform: "youtube", raw: "https://example.com/watch?v=abc12345678" },
    ctx: makeCtx(cfg),
  });
  assert.equal(r.source, "ytdlp");
  assert.equal(r.tracks.length, 1, "一次只返回选中那一条轨");
  const t = r.tracks[0];
  assert.equal(t.lang, "zh-CN");
  assert.equal(t.ai, false, "人工字幕优先");
  assert.equal(t.format, "srt");
  assert.match(r.note, /人工/);
  assert.doesNotMatch(t.content, /<[^>]*>/, "洗完不该再有尖括号标签");
  assert.doesNotMatch(t.content, /\{[^}]*\}/, "洗完不该再有花括号标签");
  assert.doesNotMatch(t.content, /\n{3,}/, "不该有连续的空行");
  // 重复的「与上一条文字完全相同」已经被删掉
  const bodies = t.content.split(/\n{2,}/).map((b) => b.split("\n")[2]).filter(Boolean);
  assert.deepEqual(bodies, ["hello world", "third line"]);
  // 序号要连续、时间轴要是标准写法
  assert.match(t.content, /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/);
});

test("fetchSubtitles：人工里没有要的语种就用站上自动生成的", async () => {
  const cfg = { ytdlpPath: await fakeExe(), preferLang: ["ja"], ytdlpSpawnFn: fakeSpawn(writeScript()) };
  const r = await fetchSubtitles({
    meta: { platform: "youtube", raw: "https://example.com/watch?v=abc12345678" },
    ctx: makeCtx(cfg),
  });
  assert.equal(r.tracks[0].lang, "ja");
  assert.equal(r.tracks[0].ai, true);
  assert.match(r.note, /自动生成/);
});

test("fetchSubtitles：要的语种一条都没有，就取视频原文语种那条", async () => {
  const cfg = { ytdlpPath: await fakeExe(), preferLang: ["ko"], ytdlpSpawnFn: fakeSpawn(writeScript()) };
  const r = await fetchSubtitles({
    meta: { platform: "youtube", raw: "https://example.com/watch?v=abc12345678" },
    ctx: makeCtx(cfg),
  });
  // 清单里 language 是 en，人工里有 en，所以取人工 en
  assert.equal(r.tracks[0].lang, "en");
  assert.equal(r.tracks[0].ai, false);
  assert.equal(r.tracks[0].langDesc, "English");
});

test("fetchSubtitles：meta 里已经有清单就直接用，不再问第二遍", async () => {
  const spawnFn = fakeSpawn(writeScript());
  const cfg = { ytdlpPath: await fakeExe(), preferLang: ["zh"], ytdlpSpawnFn: spawnFn };
  // 自己做一份和 probe 一样的清单，塞进 meta.siteProbe：外层取视频信息时就是这么给的
  const siteProbe = {
    ok: true,
    id: "abc12345678",
    title: "一个测试视频",
    durationS: 12.5,
    language: "en",
    extractor: "Youtube",
    subtitles: [{ lang: "zh-CN", name: "中文", auto: false, formats: ["vtt"] }],
    automaticCaptions: [],
  };
  const r = await fetchSubtitles({
    meta: { platform: "other", raw: "https://example.com/watch?v=abc12345678", siteProbe },
    ctx: makeCtx(cfg),
  });
  assert.equal(r.tracks[0].lang, "zh-CN");
  // 只该跑一次子进程：下字幕那次。取清单没有再跑一遍
  assert.equal(spawnFn.calls.length, 1, "清单已经有了，不许再问一遍");
  assert.ok(spawnFn.calls[0].args.includes("--write-subs"));
  assert.ok(!spawnFn.calls[0].args.includes("--dump-single-json"));
});

test("fetchSubtitles：处理完把临时目录删干净", async () => {
  const cfg = { ytdlpPath: await fakeExe(), preferLang: ["zh"], ytdlpSpawnFn: fakeSpawn(writeScript()) };
  await fetchSubtitles({
    meta: { platform: "youtube", raw: "https://example.com/watch?v=abc12345678" },
    ctx: makeCtx(cfg),
  });
  const tmpRoot = path.join(TMP_BASE, "home", "video-subtitle", "ytdlp", "tmp");
  const left = existsSync(tmpRoot) ? await fs.readdir(tmpRoot) : [];
  assert.deepEqual(left, [], "临时目录里不该留下东西");
});
