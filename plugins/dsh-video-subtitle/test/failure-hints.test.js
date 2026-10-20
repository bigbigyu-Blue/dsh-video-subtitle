import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { failureHints } from "../lib/pipeline.js";

// 临时目录建在仓库里，不建在系统临时目录：这台机器的命令行进程没有系统临时目录的写权限
const TEST_ROOT = fileURLToPath(new URL(".", import.meta.url));
const TMP_BASE = path.join(TEST_ROOT, ".tmp-hints");

const noCred = { biliCookie: "", biliCredentialFile: path.join("C:", "definitely", "not", "here", "cred.json") };

/** 造一条尝试记录。 */
const T = (provider, result, detail = "") => ({ provider, result, detail, ms: 10 });

test("没有登录凭据时，第一句就让人去扫码", () => {
  const hints = failureHints([T("native", "NO_SUBTITLE", "需要登录")], noCred);
  assert.match(hints[0], /扫码登录/);
  assert.match(hints[0], /设置/);
});

test("下载器装好了却起不来时，让人去重新检查或重装，不说成网络问题", () => {
  // 这句要是答成「网络出岔子」，人会一直重试一条其实没问题的网；
  // 答成「还没装」也不行，明明装好了会让人以为装失败了
  // 造一个真的存在、但不可能是真下载器的文件：体检只看得见「装过」，启动当然失败
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_BASE, "hint-"));
  const fakeExe = path.join(dir, "yt-dlp.exe");
  // 体检只认「大于五兆」的文件，写得小一点会被当成没装
  writeFileSync(fakeExe, Buffer.alloc(6 * 1024 * 1024, 0));
  try {
    const hints = failureHints([T("ytdlp", "DOWNLOADER_MISSING", "下载器在这台机器上没能启动")], { ytdlpPath: fakeExe });
    assert.equal(hints.length >= 1, true);
    assert.match(hints[0], /下载器/);
    assert.match(hints[0], /重新检查|重装/);
    assert.doesNotMatch(hints[0], /没装。/);
    assert.doesNotMatch(hints[0], /网络/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(TMP_BASE, { recursive: true, force: true });
  }
});

test("登录过期时说的是重新扫码，而不是第一次登录", () => {
  const hints = failureHints([T("native", "CREDENTIAL_EXPIRED", "过期的凭据")], {});
  assert.match(hints[0], /过期/);
  assert.match(hints[0], /扫码/);
  assert.doesNotMatch(hints[0], /还没有登录/);
});

test("本机转写跑挂时指向一键装转写环境", () => {
  const hints = failureHints([T("whisper", "LOCAL_ASR_FAILED", "写不出结果文件")], {});
  assert.ok(hints.some((h) => /Whisper 语音转字幕/.test(h) && /一键安装/.test(h)), hints.join(" / "));
});

test("只给试看片段时说要先登录", () => {
  const hints = failureHints([T("whisper", "AUDIO_TRUNCATED", "只有 616 秒")], {});
  assert.ok(hints.some((h) => /试看|登录/.test(h)), hints.join(" / "));
});

test("残片被门槛拦下时说清了这不是完整内容", () => {
  const hints = failureHints([T("native", "PARTIAL", "只覆盖 26%")], {});
  assert.ok(hints.some((h) => /完整度门槛/.test(h) && /残片/.test(h)), hints.join(" / "));
});

test("别的站没装下载器时，第一句就让人去装下载器", () => {
  const hints = failureHints([T("ytdlp", "DOWNLOADER_MISSING", "还没装下载器")], {});
  assert.match(hints[0], /下载器/);
  assert.match(hints[0], /一键安装/);
  assert.match(hints[0], /设置/);
});

test("网址不认识或要登录时，说清是哪一种、不替你登录", () => {
  const hints = failureHints([T("ytdlp", "UNSUPPORTED_SITE", "这个站要登录才给看")], {});
  assert.ok(hints.some((h) => /不认识/.test(h) || /要登录/.test(h)), hints.join(" / "));
  assert.ok(hints.some((h) => /不替你登录/.test(h)), hints.join(" / "));
  // 不许把「要登录」说成「视频没有字幕」
  assert.ok(!hints.some((h) => /没有字幕/.test(h)), hints.join(" / "));
});

test("什么线索都没有时也给一句能照着做的话，不返回空", () => {
  const hints = failureHints([], {});
  assert.equal(hints.length, 1);
  assert.ok(hints[0].length > 10);
});

test("最多三条，且不重复", () => {
  const hints = failureHints(
    [
      T("native", "CREDENTIAL_EXPIRED"),
      T("native", "NO_SUBTITLE"),
      T("whisper", "LOCAL_ASR_FAILED"),
      T("whisper", "AUDIO_TRUNCATED"),
      T("whisper", "PARTIAL"),
      T("local", "BAD_TIMELINE"),
      T("local", "NETWORK"),
    ],
    {},
  );
  assert.ok(hints.length <= 3, "回执不能变成一大段");
  assert.equal(new Set(hints).size, hints.length, "不许重复");
  assert.ok(hints.every((h) => typeof h === "string" && h.trim().length > 0));
});
