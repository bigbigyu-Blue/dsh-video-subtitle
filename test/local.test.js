import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
  // 不跟写死的毫秒数比：这台机器忙的时候，连起来一个 node 子进程本身就要好几百毫秒，
  // 写死的上限会在整套测试一起跑时偶然不过。改成先量一个的耗时，再看两个一起跑是不是接近两倍。
  const one = async () => {
    const t = Date.now();
    await runProcess(node, ["-e", "setTimeout(()=>{}, 1200)"], { timeoutMs: 20000 });
    return Date.now() - t;
  };
  const single = await one();
  const t0 = Date.now();
  await Promise.all([one(), one()]);
  const both = Date.now() - t0;
  // 真串起来的话两个就要两倍左右；留出进程启动与机器繁忙的浮动
  assert.ok(both < single * 1.8, `并行跑两个花了 ${both} 毫秒，单个才 ${single} 毫秒，看着像串起来跑了`);
});

test("可用性检查：缺什么就列什么，全都有就说能用", () => {
  // 这台机器上可能已经真装好了本机识别那三样，结果就会随机器状态变。
  // 把「家目录」临时指到一个不存在的目录，测的才是「什么都没装时」这一种情况。
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(path.sep, "vsub-not-installed", String(Date.now()));
  try {
    const bad = availability({ ffmpegPath: "", sherpaAddonPath: "", senseVoiceModel: "", senseVoiceTokens: "" });
    assert.equal(bad.ready, false);
    assert.ok(bad.missing.length >= 1);
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
  const ok = availability({
    ffmpegPath: node,
    sherpaAddonPath: node,
    senseVoiceModel: node,
    senseVoiceTokens: node,
  });
  assert.deepEqual(ok, { ready: true, missing: [] });
});
