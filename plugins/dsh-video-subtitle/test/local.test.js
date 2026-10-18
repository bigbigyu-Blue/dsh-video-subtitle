import test from "node:test";
import assert from "node:assert/strict";
import { runProcess, availability } from "../lib/providers/local.js";

const node = process.execPath;

test("子进程正常结束，拿得到退出码与错误输出", async () => {
  const r = await runProcess(node, ["-e", "console.error('hi'); process.exit(3)"], { timeoutMs: 15000 });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /hi/);
});

test("超时会自己掐断并说明秒数", async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => runProcess(node, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 600 }),
    /子进程超时（1 秒）/,
  );
  assert.ok(Date.now() - t0 < 5000, "不该真等 60 秒");
});

test("取消信号能立刻停下", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = runProcess(node, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 60000, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(() => p, /已取消/);
  assert.ok(Date.now() - t0 < 5000);
});

test("已经取消过的信号不会再起子进程", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => runProcess(node, ["-e", "1"], { signal: ac.signal }), /已取消/);
});

test("程序不存在时报错而不是静默成功", async () => {
  await assert.rejects(() => runProcess("dsh-no-such-program-xyz", [], { timeoutMs: 5000 }));
});

test("等子进程期间事件循环没有被卡住", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 50);
  await runProcess(node, ["-e", "setTimeout(()=>{}, 1500)"], { timeoutMs: 20000 });
  clearInterval(timer);
  assert.ok(ticks >= 8, `事件循环只跳了 ${ticks} 次，说明在同步死等`);
});

test("两个子进程并行，总耗时不叠加", async () => {
  const t0 = Date.now();
  await Promise.all([
    runProcess(node, ["-e", "setTimeout(()=>{}, 1200)"], { timeoutMs: 20000 }),
    runProcess(node, ["-e", "setTimeout(()=>{}, 1200)"], { timeoutMs: 20000 }),
  ]);
  assert.ok(Date.now() - t0 < 2300, "并行跑两个不该花两倍时间");
});

test("可用性检查：缺什么就列什么，全都有就说能用", () => {
  const bad = availability({ ffmpegPath: "", sherpaAddonPath: "", senseVoiceModel: "", senseVoiceTokens: "" });
  assert.equal(bad.ready, false);
  assert.ok(bad.missing.length >= 1);
  const ok = availability({
    ffmpegPath: node,
    sherpaAddonPath: node,
    senseVoiceModel: node,
    senseVoiceTokens: node,
  });
  assert.deepEqual(ok, { ready: true, missing: [] });
});
