import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVIDERS, fetchTimeoutBudget, providersStatus, subtitleFetch } from "../lib/pipeline.js";

test("等待上限跟着源数量走，不写死", () => {
  // 预算只按实际启用的源数算：默认那套里有 whisper，所以另加一份转写时间
  const all = fetchTimeoutBudget({ timeoutMs: 10000 });
  const allCount = Object.keys(PROVIDERS).length;
  assert.equal(all, 30000 + 10000 * allCount + 1800000 + 15000);
  const two = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["native", "local"] });
  const one = fetchTimeoutBudget({ timeoutMs: 10000, providerOrder: ["native"] });
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
  assert.equal(fetchTimeoutBudget({}), 30000 + 90000 * Object.keys(PROVIDERS).length + 1800000 + 15000);
  // 名单里写错名字时按 1 个算，不至于算出负数或 0
  assert.ok(fetchTimeoutBudget({ timeoutMs: 5000, providerOrder: ["不存在的源"] }) > 0);
});

test("状态清单含全部来源，本地源缺件时如实列出来", () => {
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
  assert.match(local.placeholder, /^还没装好（缺 /);
  assert.doesNotMatch(local.placeholder, /占位返回|缺 AAC 解码/, "过期说法必须去掉");
  // 这条来源是可选的：缺件不算故障，界面上不该显示成红的
  assert.equal(local.optional, true);
  for (const p of list.filter((x) => x.provider !== "local" && x.provider !== "ytdlp")) {
    assert.equal(p.optional, false, p.provider + "不是可选来源");
  }
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

test("除可选来源外都不带缺件说明", () => {
  // local 与 ytdlp 是可选的路：只在用得到它们时才需要装，不装不影响 B站 那条
  const OPTIONAL = new Set(["local", "ytdlp"]);
  const list = providersStatus({});
  for (const p of list.filter((x) => !OPTIONAL.has(x.provider) && x.provider !== "whisper")) {
    assert.equal(p.placeholder, null);
    assert.equal(p.missing, null);
    assert.equal(p.wired, true);
  }
  for (const p of list.filter((x) => OPTIONAL.has(x.provider))) {
    assert.equal(p.optional, true, p.provider + " 是可选来源");
  }
});

test("别的站没装下载器时：如实失败、给出装下载器那一步，不编一个成功", async () => {
  // 这台机器多半没装下载器；把家目录指到空目录，测的就是「什么都没装」这一种情况
  // 临时目录一律开在仓库里的 test 目录下：这台机器上系统临时目录对受限进程不可写
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const base = path.join(HERE, ".tmp-pipeline-other-" + process.pid);
  mkdirSync(base, { recursive: true });
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const v = await subtitleFetch({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      cfg: {
        saveDir: path.join(process.env.DSH_HOME, "out"),
        providerOrder: ["native", "ytdlp"],
        timeoutMs: 5000,
      },
    });
    assert.equal(v.ok, false);
    assert.equal(v.platform, "youtube");
    // 别的站也要有自己那一栏编号，不能整行空着
    assert.ok(v.videoId, "要有视频编号那一栏");
    assert.ok(v.site, "要留下站名，人一眼知道是哪来的");
    const dm = (v.attempts ?? []).find((a) => a.provider === "ytdlp");
    assert.equal(dm?.result, "DOWNLOADER_MISSING");
    assert.ok((v.hints ?? []).some((h) => /下载器/.test(h) && /一键安装/.test(h)), JSON.stringify(v.hints));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test("站点来源也在状态清单里，界面上有名字可显示", () => {
  const list = providersStatus({});
  const y = list.find((x) => x.provider === "ytdlp");
  assert.ok(y, "来源链上要有「站上现成字幕」这一条");
  assert.equal(y.wired, true);
  assert.equal(y.optional, true);
});
