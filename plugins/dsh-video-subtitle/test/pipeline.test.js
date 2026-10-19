import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PROVIDERS, fetchTimeoutBudget, providersStatus } from "../lib/pipeline.js";

test("等待上限跟着源数量走，不写死", () => {
  const all = fetchTimeoutBudget({ timeoutMs: 10000 });
  const two = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["native", "local"] });
  const one = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["native"] });
  assert.equal(all, 30000 + 10000 * 3 + 1800000 + 15000);
  assert.equal(two, 30000 + 10000 * 2 + 15000);
  assert.equal(one, 30000 + 10000 * 1 + 15000);
  assert.ok(one < two && two < all, "源越少预算越小");
});

test("名单里有 whisper 时预算要容得下整段转写", () => {
  const withW = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["local", "whisper"] });
  const noW = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["local", "native"] });
  assert.ok(withW - noW > 1000000, "whisper 必须单独留出转写时间，不能按 90 秒算");
  assert.equal(withW, 30000 + 10000 * 2 + 1800000 + 15000);
});

test("等待上限对异常配置仍然有下限", () => {
  assert.equal(fetchTimeoutBudget({ timeoutMs: 0, providerOrder: [] }), 30000 + 1000 * 1 + 15000);
  assert.equal(fetchTimeoutBudget({}), 30000 + 90000 * 3 + 1800000 + 15000);
  // 名单里写错名字时按 1 个算，不至于算出负数或 0
  assert.ok(fetchTimeoutBudget({ timeoutMs: 5000, providerOrder: ["不存在的源"] }) > 0);
});

test("状态清单含三个源，本地源缺件时如实列出来", () => {
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
  assert.match(local.placeholder, /^需要额外安装，默认不用/);
  assert.doesNotMatch(local.placeholder, /占位返回|缺 AAC 解码/, "过期说法必须去掉");
  // 这条来源是可选的：缺件不算故障，界面上不该显示成红的
  assert.equal(local.optional, true);
  for (const p of list.filter((x) => x.provider !== "local")) assert.equal(p.optional, false, p.provider + "不是可选来源");
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

test("除本地源外都不带缺件说明", () => {
  const list = providersStatus({});
  for (const p of list.filter((x) => x.provider !== "local" && x.provider !== "whisper")) {
    assert.equal(p.placeholder, null);
    assert.equal(p.missing, null);
    assert.equal(p.wired, true);
  }
});
