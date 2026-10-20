import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ytdlpEnvPaths,
  ytdlpStatus,
  ytdlpSetupState,
  startYtdlpSetup,
  cancelYtdlpSetup,
} from "../lib/ytdlp-env.js";

// 所有临时目录都开在仓库里面的 test 目录下，不走系统临时目录，收尾整个删掉。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_BASE = path.join(HERE, ".tmp-ytdlp-env-" + process.pid);
let tmpSeq = 0;

function tmpDir(name) {
  tmpSeq += 1;
  const dir = path.join(TMP_BASE, name + "-" + tmpSeq);
  mkdirSync(dir, { recursive: true });
  return dir;
}

after(async () => {
  await fs.rm(TMP_BASE, { recursive: true, force: true });
});

/** 下载器本体按「大于 5 兆」才算装好，测试里造 6 兆。 */
const BIG_BYTES = 6 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等后台安装任务跑完；超时就断言失败，不许一直挂着。 */
async function waitIdle(timeoutMs = 20000) {
  const t0 = Date.now();
  while (ytdlpSetupState().running) {
    if (Date.now() - t0 > timeoutMs) throw new Error("后台安装任务一直没结束");
    await sleep(10);
  }
  return ytdlpSetupState();
}

/** 填指定字节的内容，内容不重要，只要够长。 */
function filler(bytes, seed = 0x61) {
  const buf = Buffer.alloc(bytes);
  buf.fill(seed);
  return buf;
}

/** 造一个指定大小的文件（大批量用截断，不真占内存）。 */
async function touchSized(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, "w");
  try {
    await fh.truncate(bytes);
  } finally {
    await fh.close();
  }
}

/**
 * 假的子进程：拿 EventEmitter 凑一个孩子，按参数把预设输出吐出来再关掉。
 * 复查那一步跑的是 exe --version，这里就是它。
 */
function fakeSpawn({ stdout = "", stderr = "", status = 0 } = {}) {
  const calls = [];
  const spawnFn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ exe, args, opts });
    setTimeout(() => {
      if (child.killed) return;
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", status);
    }, 0);
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

/** 假响应：包一层真 Response，省得自己实现 headers 和 body。 */
function res200(body, headers = {}) {
  return new Response(body, { status: 200, headers });
}

/** 假 fetch 的公共外壳：记下每次请求，把 AbortSignal 接到流上。 */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    const call = { url: String(url), headers, aborted: false };
    calls.push(call);
    const signal = init.signal;
    signal?.addEventListener?.("abort", () => {
      call.aborted = true;
    }, { once: true });
    return handler({ url: String(url), headers, signal, call, calls });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** 一段可以慢慢吐的流，取消时立刻报错，模拟真实请求被掐断。 */
function slowBody(total, signal, { chunk = 64 * 1024, delay = 20 } = {}) {
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      if (sent >= total) {
        controller.close();
        return;
      }
      await sleep(delay);
      if (signal?.aborted) {
        controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x62));
    },
    cancel() {},
  });
}

test("ytdlpEnvPaths：四样东西都落在临时家目录下的 ytdlp 里", () => {
  const home = path.join(TMP_BASE, "home-paths");
  const p = ytdlpEnvPaths({}, { home });
  assert.equal(p.root, path.join(home, "video-subtitle", "ytdlp"));
  assert.equal(p.bin, path.join(p.root, "bin"));
  assert.equal(p.exe, path.join(p.root, "bin", "yt-dlp.exe"));
  assert.equal(p.tmp, path.join(p.root, "tmp"));
});

test("ytdlpEnvPaths：配置里填了 ytdlpPath 就用用户自己指的那个", () => {
  const home = path.join(TMP_BASE, "home-cfg");
  const mine = path.join(home, "我的下载器.exe");
  const p = ytdlpEnvPaths({ ytdlpPath: mine }, { home });
  assert.equal(p.exe, mine);
  // 其余几项不受影响
  assert.equal(p.root, path.join(home, "video-subtitle", "ytdlp"));
});

test("ytdlpStatus：还没装的时候说清楚，并提示点一键安装", () => {
  const home = path.join(TMP_BASE, "home-empty");
  const st = ytdlpStatus({}, { home });
  assert.equal(st.ready, false);
  assert.equal(st.present, false);
  assert.equal(st.bytes, 0);
  assert.equal(st.version, "");
  assert.match(st.detail, /还没装/);
  assert.match(st.detail, /一键安装/);
});

test("ytdlpStatus：文件只有一小截不算装好，要说还差多久下完", async () => {
  const home = path.join(TMP_BASE, "home-half");
  const p = ytdlpEnvPaths({}, { home });
  await touchSized(p.exe, 3200000);
  const st = ytdlpStatus({}, { home });
  assert.equal(st.ready, false);
  assert.equal(st.present, false);
  assert.equal(st.bytes, 3200000);
  assert.match(st.detail, /文件只有 3\.2 兆/);
  assert.match(st.detail, /接着下/);
});

test("ytdlpStatus：够大并且记了版本号才算装好", async () => {
  const home = path.join(TMP_BASE, "home-ok");
  const p = ytdlpEnvPaths({}, { home });
  await touchSized(p.exe, BIG_BYTES);
  await fs.mkdir(p.root, { recursive: true });
  await fs.writeFile(path.join(p.root, "version.txt"), "2026.08.19\n", "utf8");
  const st = ytdlpStatus({}, { home });
  assert.equal(st.ready, true);
  assert.equal(st.present, true);
  assert.equal(st.version, "2026.08.19");
  assert.match(st.detail, /已经装好，版本 2026\.08\.19/);
});

test("一键安装：全新下载走 200，下完改名并复查通过", async () => {
  const home = path.join(TMP_BASE, "home-200");
  const p = ytdlpEnvPaths({}, { home });
  const total = BIG_BYTES;

  const fetchImpl = makeFetch(({ url }) => {
    if (!url.includes("yt-dlp.exe")) throw new Error("这个测试不该去请求 " + url);
    return res200(filler(total), { "content-length": String(total) });
  });
  const spawnFn = fakeSpawn({ stdout: "2026.08.19\n" });

  const started = await startYtdlpSetup({}, { fetchImpl, home, spawnFn });
  assert.equal(started.started, true);
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  const step = (id) => st.steps.find((s) => s.id === id);
  assert.equal(step("download").state, "done");
  assert.equal(step("download").bytesDone, total);
  assert.equal(step("download").bytesTotal, total);
  assert.equal(step("download").percent, 100);
  assert.equal(step("verify").state, "done");
  assert.equal(statSync(p.exe).size, total);
  assert.equal(existsSync(p.exe + ".part"), false, "装完不该留下半截文件");
  assert.equal(ytdlpStatus({}, { home }).ready, true);
  assert.equal(ytdlpStatus({}, { home }).version, "2026.08.19");
  assert.equal(spawnFn.calls.length, 1);
  assert.deepEqual(spawnFn.calls[0].args, ["--version"]);
  assert.equal(spawnFn.calls[0].opts.windowsHide, true);
  // 复查必须把子进程的临时目录指到插件自己的 tmp，否则这台机器上直接报 [PYI-2060]
  assert.equal(spawnFn.calls[0].opts.env.TEMP, p.tmp);
  assert.equal(spawnFn.calls[0].opts.env.TMP, p.tmp);
  assert.ok(existsSync(p.tmp), "子进程临时目录要真的建出来");
});

test("一键安装：本地已有装好的文件，下载这一步标成跳过", async () => {
  const home = path.join(TMP_BASE, "home-skip");
  const p = ytdlpEnvPaths({}, { home });
  await touchSized(p.exe, BIG_BYTES);
  const fetchImpl = makeFetch(() => {
    throw new Error("已经装好了，不该联网");
  });
  const spawnFn = fakeSpawn({ stdout: "2026.08.19\n" });
  await startYtdlpSetup({}, { fetchImpl, home, spawnFn });
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  assert.equal(st.steps.find((s) => s.id === "download").state, "skipped");
  assert.equal(st.steps.find((s) => s.id === "verify").state, "done");
});

test("一键安装：本地有半截文件时带 Range 接着下，落盘大小对得上", async () => {
  const home = path.join(TMP_BASE, "home-206");
  const p = ytdlpEnvPaths({}, { home });
  const had = 1500000;
  const total = BIG_BYTES;
  await fs.mkdir(p.bin, { recursive: true });
  await fs.writeFile(p.exe + ".part", filler(had));

  const fetchImpl = makeFetch(({ url, headers }) => {
    if (!url.includes("yt-dlp.exe")) throw new Error("不该请求 " + url);
    assert.equal(headers.range, "bytes=" + had + "-", "续传要带上 Range");
    const rest = filler(total - had, 0x63);
    return new Response(rest, {
      status: 206,
      headers: {
        "content-range": "bytes " + had + "-" + (total - 1) + "/" + total,
        "content-length": String(rest.length),
      },
    });
  });
  const spawnFn = fakeSpawn({ stdout: "2026.08.19\n" });

  await startYtdlpSetup({}, { fetchImpl, home, spawnFn });
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  assert.equal(statSync(p.exe).size, total);
  const dl = st.steps.find((s) => s.id === "download");
  assert.equal(dl.bytesDone, total);
  assert.equal(dl.bytesTotal, total);
});

test("一键安装：镜像站失败会自动改走官方地址", async () => {
  const home = path.join(TMP_BASE, "home-fallback");
  const p = ytdlpEnvPaths({}, { home });
  const total = BIG_BYTES;
  let mirrorHits = 0;

  const fetchImpl = makeFetch(({ url }) => {
    if (url.includes("ghfast.top")) {
      mirrorHits += 1;
      return new Response("boom", { status: 503 });
    }
    if (url.includes("github.com/yt-dlp/yt-dlp/releases")) return res200(filler(total), { "content-length": String(total) });
    throw new Error("这个测试不该去请求 " + url);
  });
  const spawnFn = fakeSpawn({ stdout: "2026.08.19\n" });

  await startYtdlpSetup({}, { fetchImpl, home, spawnFn });
  const st = await waitIdle(40000);
  assert.equal(st.ok, true, st.error || "");
  assert.ok(mirrorHits >= 1, "镜像站要先试过");
  assert.equal(statSync(p.exe).size, total);
  assert.ok(st.log.some((line) => /官方地址/.test(line)), "日志里要写清换了地址");
});

test("一键安装：一直失败就说清是哪一步没下来，不留下装了一半的 exe", async () => {
  const home = path.join(TMP_BASE, "home-dead");
  const p = ytdlpEnvPaths({}, { home });
  const fetchImpl = makeFetch(() => new Response("boom", { status: 503 }));
  const spawnFn = fakeSpawn({ stdout: "2026.08.19\n" });

  await startYtdlpSetup({}, { fetchImpl, home, spawnFn });
  const st = await waitIdle(60000);
  assert.equal(st.ok, false);
  assert.equal(st.steps.find((s) => s.id === "download").state, "failed");
  assert.equal(st.steps.find((s) => s.id === "verify").state, "pending");
  assert.match(st.error, /下载器/);
  assert.doesNotMatch(st.error, /https?:\/\//, "错误里不该出现完整下载地址");
  assert.equal(existsSync(p.exe), false);
});

test("一键安装：下载器跑不起来时，复查那一步失败的说明是句人话", async () => {
  const home = path.join(TMP_BASE, "home-badverify");
  const p = ytdlpEnvPaths({}, { home });
  const fetchImpl = makeFetch(() => res200(filler(BIG_BYTES), { "content-length": String(BIG_BYTES) }));
  // 版本号对不上：输出里没有 2026.08.19 这种样子
  const spawnFn = fakeSpawn({ stdout: "not a version here" });

  await startYtdlpSetup({}, { fetchImpl, home, spawnFn });
  const st = await waitIdle();
  assert.equal(st.ok, false);
  const verify = st.steps.find((s) => s.id === "verify");
  assert.equal(verify.state, "failed");
  assert.match(st.error, /下载器跑不起来，点一键安装重下/);
  assert.equal(existsSync(path.join(p.root, "version.txt")), false, "没验过就不该写版本号");
});

test("取消安装：正在下的请求真的被掐断，半截文件留着下次接着下", async () => {
  const home = path.join(TMP_BASE, "home-cancel");
  const p = ytdlpEnvPaths({}, { home });
  let sawAbort = false;

  const fetchImpl = makeFetch(({ url, signal }) => {
    if (!url.includes("yt-dlp.exe")) throw new Error("不该请求 " + url);
    signal?.addEventListener?.("abort", () => {
      sawAbort = true;
    }, { once: true });
    return res200(slowBody(BIG_BYTES, signal), { "content-length": String(BIG_BYTES) });
  });
  const spawnFn = fakeSpawn({ stdout: "2026.08.19\n" });

  const started = await startYtdlpSetup({}, { fetchImpl, home, spawnFn });
  assert.equal(started.started, true);

  const part = p.exe + ".part";
  const t0 = Date.now();
  while (!existsSync(part) || statSync(part).size === 0) {
    if (Date.now() - t0 > 15000) throw new Error("等不到下载开始的迹象");
    await sleep(20);
  }
  const c = cancelYtdlpSetup();
  assert.equal(c.cancelled, true);
  const st = await waitIdle();
  assert.equal(st.ok, false);
  assert.equal(st.error, "安装已取消");
  assert.equal(st.steps.find((s) => s.id === "download").state, "failed");
  assert.equal(sawAbort, true, "取消必须真的停掉请求");
  assert.ok(statSync(part).size > 0, "半截文件要留着");
  assert.ok(st.log.some((line) => /留着/.test(line)), "日志里要说明下次接着下");
  assert.equal(existsSync(p.exe), false);
  assert.equal(cancelYtdlpSetup().cancelled, false, "没任务在跑时取消就什么都不做");
});

test("任务状态：两个步骤的 id 与中文名字都是固定的", async () => {
  const home = path.join(TMP_BASE, "home-steps");
  const p = ytdlpEnvPaths({}, { home });
  await touchSized(p.exe, BIG_BYTES);
  const fetchImpl = makeFetch(() => {
    throw new Error("已经装好了，不该联网");
  });
  await startYtdlpSetup({}, { fetchImpl, home, spawnFn: fakeSpawn({ stdout: "2026.08.19\n" }) });
  const st = await waitIdle();
  assert.deepEqual(st.steps.map((s) => s.id), ["download", "verify"]);
  assert.deepEqual(st.steps.map((s) => s.label), ["下载下载器", "复查能不能用"]);
  for (const s of st.steps) {
    assert.ok(["pending", "running", "done", "failed", "skipped"].includes(s.state));
    assert.equal(typeof s.bytesDone, "number");
    assert.equal(typeof s.bytesTotal, "number");
    assert.equal(typeof s.percent, "number");
  }
  assert.ok(st.log.length > 0, "日志里要写清干了什么");
  // 返回的是副本：外面改不到内部状态
  st.steps[0].state = "乱改";
  st.log.length = 0;
  const again = ytdlpSetupState();
  assert.notEqual(again.steps[0].state, "乱改");
  assert.ok(again.log.length > 0);
});

test("日志脱敏：用户目录与带查询串的地址都不许露出来", async () => {
  const home = path.join(TMP_BASE, "home-log");
  const fetchImpl = makeFetch(() => new Response("boom", { status: 503 }));
  const lines = [];
  await startYtdlpSetup({}, { fetchImpl, home, log: (l) => lines.push(l), spawnFn: fakeSpawn({}) });
  const st = await waitIdle(60000);
  assert.equal(st.ok, false);
  const all = st.log.join("\n");
  assert.doesNotMatch(all, /[A-Za-z]:\\Users\\/i, "日志里不该出现用户目录");
  assert.doesNotMatch(all, /\?[^\s]*=/, "日志里不该出现带查询串的地址");
  assert.ok(lines.length > 0, "外部日志回调要收到每一行");
});
