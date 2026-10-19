import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { failureHints } from "../lib/pipeline.js";

const noCred = { biliCookie: "", biliCredentialFile: path.join("C:", "definitely", "not", "here", "cred.json") };

/** 造一条尝试记录。 */
const T = (provider, result, detail = "") => ({ provider, result, detail, ms: 10 });

test("没有登录凭据时，第一句就让人去扫码", () => {
  const hints = failureHints([T("native", "NO_SUBTITLE", "需要登录")], noCred);
  assert.match(hints[0], /扫码登录/);
  assert.match(hints[0], /设置/);
});

test("登录过期时说的是重新扫码，而不是第一次登录", () => {
  const hints = failureHints([T("native", "CREDENTIAL_EXPIRED", "过期的凭据")], {});
  assert.match(hints[0], /过期/);
  assert.match(hints[0], /扫码/);
  assert.doesNotMatch(hints[0], /还没有登录/);
});

test("本机转写跑挂时指向一键装转写环境", () => {
  const hints = failureHints([T("whisper", "LOCAL_ASR_FAILED", "写不出结果文件")], {});
  assert.ok(hints.some((h) => /一键安装转写环境/.test(h)), hints.join(" / "));
});

test("只给试看片段时说要先登录", () => {
  const hints = failureHints([T("whisper", "AUDIO_TRUNCATED", "只有 616 秒")], {});
  assert.ok(hints.some((h) => /试看|登录/.test(h)), hints.join(" / "));
});

test("残片被门槛拦下时说清了这不是完整内容", () => {
  const hints = failureHints([T("native", "PARTIAL", "只覆盖 26%")], {});
  assert.ok(hints.some((h) => /完整度门槛/.test(h) && /残片/.test(h)), hints.join(" / "));
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
