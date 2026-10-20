import test, { after } from "node:test";
import assert from "node:assert/strict";
import { splitWordsToCues, availability, makeTmpDir } from "../lib/providers/whisper.js";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 临时目录开在仓库内的 test 目录下，不走系统临时目录（受限环境下那里建不了目录）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_BASE = path.join(HERE, ".tmp-whisper-" + process.pid);
mkdirSync(TMP_BASE, { recursive: true });
after(() => rmSync(TMP_BASE, { recursive: true, force: true }));

/** 造词：w(text, start, end) */
const w = (text, start, end) => ({ text, start, end });

test("遇到句末标点就断开", () => {
  const cues = splitWordsToCues(
    [w("今天", 0, 0.4), w("很好", 0.4, 0.8), w("。", 0.8, 0.9), w("明天", 1.0, 1.4), w("见", 1.4, 1.6), w("。", 1.6, 1.7)],
    { maxChars: 24 },
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "今天很好。");
  assert.equal(cues[1].text, "明天见。");
});

test("没到句末标点但超过字数上限也断开", () => {
  const words = [];
  for (let i = 0; i < 30; i += 1) words.push(w("字", i, i + 0.1));
  const cues = splitWordsToCues(words, { maxChars: 10 });
  assert.ok(cues.length >= 3, `应该切成至少 3 条，实际 ${cues.length}`);
  for (const c of cues) assert.ok(c.text.length <= 10, `条目超长：${c.text}`);
});

test("空输入返回空数组", () => {
  assert.deepEqual(splitWordsToCues([], { maxChars: 24 }), []);
  assert.deepEqual(splitWordsToCues(null, { maxChars: 24 }), []);
  assert.deepEqual(splitWordsToCues([w("   ", 0, 0.1)], { maxChars: 24 }), []);
});

test("只有单个词也能成条", () => {
  const cues = splitWordsToCues([w("好", 2, 2.5)], { maxChars: 24 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "好");
  assert.equal(cues[0].start, 2);
  assert.equal(cues[0].end, 2.5);
});

test("时间戳单调、end 一定大于 start", () => {
  const cues = splitWordsToCues(
    [
      w("第一句", 0, 0.5),
      w("。", 0.5, 0.4), // 故意给个倒挂的 end
      w("第二句", 1, 1.5),
      w("结尾", 1.5, 1.5), // start 等于 end
    ],
    { maxChars: 24 },
  );
  assert.ok(cues.length >= 2);
  for (let i = 0; i < cues.length; i += 1) {
    assert.ok(cues[i].end > cues[i].start, `第 ${i} 条 end 没有大于 start`);
    if (i > 0) assert.ok(cues[i].start >= cues[i - 1].end - 1e-9, `第 ${i} 条时间轴没有递增`);
  }
});

test("空格词被丢掉，不产生空条目", () => {
  const cues = splitWordsToCues([w("  ", 0, 0.1), w("真", 0.1, 0.2), w(" ", 0.2, 0.3), w("好", 0.3, 0.4)], { maxChars: 24 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "真好");
});

test("问号感叹号省略号也算句末", () => {
  for (const p of ["？", "！", "?", "!", "…"]) {
    const cues = splitWordsToCues([w("甲", 0, 0.1), w(p, 0.1, 0.2), w("乙", 0.3, 0.4)], { maxChars: 24 });
    assert.equal(cues.length, 2, `标点 ${p} 没断开`);
  }
});

test("缺 python 时 availability 报不可用并说明缺什么", () => {
  const r = availability({ whisperPython: "D:\\no-such-dir-xyz\\python.exe" });
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => m.includes("Python")), `missing 里没有 Python 说明：${r.missing.join(" / ")}`);
});

test("首选临时目录建不了，就退到备用目录", async () => {
  const good = mkdtempSync(path.join(TMP_BASE, "good-"));
  // 拿一个普通文件当目录用，必定建不进去
  const blocker = path.join(good, "占位文件");
  writeFileSync(blocker, "");
  try {
    const tmp = await makeTmpDir(path.join(blocker, "下面"), [good]);
    assert.ok(tmp.startsWith(good), `临时目录没落在备用位置：${tmp}`);
    assert.ok(existsSync(tmp), "临时目录没有真的建出来");
    rmSync(tmp, { recursive: true, force: true });
  } finally {
    rmSync(good, { recursive: true, force: true });
  }
});

test("所有临时目录都建不了时，报错里写清试过哪些地方", async () => {
  const root = mkdtempSync(path.join(TMP_BASE, "bad-"));
  const blocker = path.join(root, "占位文件");
  writeFileSync(blocker, "");
  // makeTmpDir 最后还会拿系统临时目录兜底。系统临时目录在有些机器上能写、有些不能写，
  // 不把它也堵死，这条用例就会随机器状态时过时不过。把它指到一个普通文件下面，才测得到「全都建不了」。
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = path.join(blocker, "丙");
  process.env.TMP = path.join(blocker, "丙");
  process.env.TEMP = path.join(blocker, "丙");
  try {
    await assert.rejects(
      () => makeTmpDir(path.join(blocker, "甲"), [path.join(blocker, "乙")]),
      (e) => /临时目录都建不了/.test(e.message) && /whisperTmpDir/.test(e.message),
    );
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
