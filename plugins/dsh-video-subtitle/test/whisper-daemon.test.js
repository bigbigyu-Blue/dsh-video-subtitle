/**
 * 常驻转写进程的测试：全程用一个假的转写程序，不加载真实模型、不碰 Python。
 *
 * 假程序干的事跟真的一致：从标准输入一行一行读任务、一行一行回 @@VSUB@@ 结果。
 * 它把「被启动过一次」记进日志文件，所以「连跑三条只启动一次」是可验证的事实，不是猜的。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../lib/providers/whisper.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, ".tmp-daemon-" + process.pid);

/** 假的转写程序：跟真的脚本一样从标准输入读任务、往标准输出回一行结果。 */
const FAKE = `import fs from "node:fs";
const [log, mode] = process.argv.slice(2);
fs.appendFileSync(log, "start:" + process.pid + "\\n");
let buf = "";
let seen = 0;
process.stdin.on("data", (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    seen += 1;
    if (mode === "hang") continue;
    if (mode === "crash" && seen > 1) process.exit(3);
    process.stdout.write("@@VSUB@@" + JSON.stringify({ ok: true, error: "", wrote: true, pid: process.pid, seq: req.seq }) + "\\n");
  }
});
`;

let seq = 0;

async function setup(mode = "ok") {
  await fs.mkdir(DIR, { recursive: true });
  const id = "t" + ++seq;
  const dir = path.join(DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, "fake.mjs");
  const log = path.join(dir, "starts.log");
  await fs.writeFile(script, FAKE, "utf8");
  await fs.writeFile(log, "", "utf8");
  // 用 node 当「解释器」：被测代码只管把脚本与参数交出去，不知道里面是 Python 还是 node
  const spawnFn = (_python, args, opts) =>
    spawn(process.execPath, [args[0], log, mode], { ...opts, stdio: ["pipe", "pipe", "pipe"] });
  const p = { python: "fake", hfHome: dir, script };
  return { p, log, spawnFn, dir };
}

async function starts(log) {
  const txt = await fs.readFile(log, "utf8");
  return txt.split("\n").filter(Boolean).length;
}

const job = (n) => ({ audio: "a.m4s", out: "out.json", seq: n, model: "small", threads: 4 });

test("连跑三条只启动一次进程，三条都回到结果", async () => {
  const { p, log, spawnFn } = await setup();
  const d = createDaemon({ spawnFn });
  try {
    const r1 = await d.run(p, job(1));
    const r2 = await d.run(p, job(2));
    const r3 = await d.run(p, job(3));
    assert.deepEqual([r1.seq, r2.seq, r3.seq], [1, 2, 3]);
    assert.equal(r1.pid, r3.pid, "三条应当是同一个进程在跑");
    assert.equal(await starts(log), 1, "只该启动一次");
  } finally {
    d.stop();
  }
});

test("进程崩了会自己重开，崩掉那条报错、后面那条照常出结果", async () => {
  const { p, log, spawnFn } = await setup("crash");
  const d = createDaemon({ spawnFn });
  try {
    await d.run(p, job(1));
    await assert.rejects(() => d.run(p, job(2)), /转写进程退出了/);
    const r3 = await d.run(p, job(3));
    assert.equal(r3.seq, 3);
    assert.equal(await starts(log), 2, "崩过一次就该重开一次");
  } finally {
    d.stop();
  }
});

test("卡住不动的那条会按超时报错，并把这个进程扔掉", async () => {
  const { p, spawnFn } = await setup("hang");
  const d = createDaemon({ spawnFn });
  try {
    await assert.rejects(() => d.run(p, job(1), { timeoutMs: 300 }), /转写超时/);
    assert.equal(d.alive, false, "超时后不该留着这个进程");
  } finally {
    d.stop();
  }
});

test("关掉复用之后每条都新开进程", async () => {
  const { p, log, spawnFn } = await setup();
  const d = createDaemon({ spawnFn });
  try {
    for (const n of [1, 2, 3]) await d.run(p, job(n), { keep: false });
    assert.equal(await starts(log), 3, "不复用时三条就是三个进程");
    assert.equal(d.alive, false);
  } finally {
    d.stop();
  }
});

test("插件退出时能把进程收掉", async () => {
  const { p, spawnFn } = await setup();
  const d = createDaemon({ spawnFn });
  await d.run(p, job(1));
  assert.equal(d.alive, true);
  d.stop();
  assert.equal(d.alive, false);
});

test("用完删掉测试目录", async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});
