import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PROVIDERS, fetchTimeoutBudget, providersStatus } from "../lib/pipeline.js";

test("等待上限跟着源数量走，不写死", () => {
  const all = fetchTimeoutBudget({ timeoutMs: 10000 });
  const two = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["native", "bcut"] });
  const one = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["native"] });
  assert.equal(all, 30000 + 10000 * 4 + 15000);
  assert.equal(two, 30000 + 10000 * 2 + 15000);
  assert.equal(one, 30000 + 10000 * 1 + 15000);
  assert.ok(one < two && two < all, "源越少预算越小");
});

test("等待上限对异常配置仍然有下限", () => {
  assert.equal(fetchTimeoutBudget({ timeoutMs: 0, providerOrder: [] }), 30000 + 1000 * 1 + 15000);
  assert.equal(fetchTimeoutBudget({}), 30000 + 90000 * 4 + 15000);
  // 名单里写错名字时按 1 个算，不至于算出负数或 0
  assert.ok(fetchTimeoutBudget({ timeoutMs: 5000, providerOrder: ["不存在的源"] }) > 0);
});

test("状态清单含四个源，本地源缺件时如实列出来", () => {
  const list = providersStatus({
    ffmpegPath: path.join(os.tmpdir(), "definitely-no-ffmpeg"),
    sherpaAddonPath: path.join(os.tmpdir(), "definitely-no-addon"),
    senseVoiceModel: path.join(os.tmpdir(), "no-model.onnx"),
    senseVoiceTokens: path.join(os.tmpdir(), "no-tokens.txt"),
  });
  const ids = list.map((x) => x.provider);
  assert.deepEqual(ids, Object.keys(PROVIDERS));
  const local = list.find((x) => x.provider === "local");
  assert.equal(local.wired, true);
  assert.ok(Array.isArray(local.missing) && local.missing.length >= 1, "缺件必须列出来");
  assert.match(local.placeholder, /^本机缺：/);
  assert.doesNotMatch(local.placeholder, /占位返回|缺 AAC 解码/, "过期说法必须去掉");
});

test("本地源没缺件时不再写任何缺件说明", () => {
  const cfg = {
    ffmpegPath: process.execPath,
    sherpaAddonPath: process.execPath,
    senseVoiceModel: process.execPath,
    senseVoiceTokens: process.execPath,
  };
  const local = providersStatus(cfg).find((x) => x.provider === "local");
  assert.equal(local.missing, null);
  assert.equal(local.placeholder, null);
});

test("其余三个源不带缺件说明", () => {
  const list = providersStatus({});
  for (const p of list.filter((x) => x.provider !== "local")) {
    assert.equal(p.placeholder, null);
    assert.equal(p.missing, null);
    assert.equal(p.wired, true);
  }
});
