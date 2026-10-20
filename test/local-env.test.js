import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  localEnvPaths,
  localStatus,
  startLocalSetup,
  localSetupState,
  cancelLocalSetup,
} from "../lib/local-env.js";

// 所有临时目录都开在仓库里面的 test 目录下，不走系统临时目录，收尾整个删掉。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_BASE = path.join(HERE, ".tmp-local-env-" + process.pid);
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

const MODEL_BYTES = 239233841;
const TOKENS_BYTES = 315894;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等后台安装任务跑完；超时就断言失败，不许一直挂着。 */
async function waitIdle(timeoutMs = 15000) {
  const t0 = Date.now();
  while (localSetupState().running) {
    if (Date.now() - t0 > timeoutMs) throw new Error("后台安装任务一直没结束");
    await sleep(10);
  }
  return localSetupState();
}

/** 造一个指定大小的文件，模型这种几百兆的用截断，不真占内存。 */
async function touchSized(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, "w");
  try {
    await fh.truncate(bytes);
  } finally {
    await fh.close();
  }
}

/** 填指定字节的内容，内容不重要，只要够长。 */
function filler(bytes, seed = 0x61) {
  const buf = Buffer.alloc(bytes);
  buf.fill(seed);
  return buf;
}

/**
 * 拼一个最小的 zip（wheel 就是 zip）：只写本地文件头、中央目录和结尾记录，
 * 跟被测代码认的那两种结构头一一对上。不校验 crc，所以那一栏写 0。
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(e.name, "utf8");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 造一个带 ffmpeg 的 wheel，里面的 exe 大小够过「大于 10 兆」那一关。 */
function wheelWithFfmpeg(exeBytes = 11 * 1024 * 1024) {
  return buildZip([
    { name: "imageio_ffmpeg-0.6.0.dist-info/METADATA", data: "Name: imageio-ffmpeg" },
    { name: "imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe", data: filler(exeBytes) },
  ]);
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
    const raw = init.headers || {};
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    const call = { url: String(url), headers, aborted: false };
    calls.push(call);
    const signal = init.signal;
    if (signal) {
      signal.addEventListener?.("abort", () => {
        call.aborted = true;
      }, { once: true });
    }
    return handler({ url: String(url), headers, signal, call, calls });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** 一段可以慢慢吐的流，取消时立刻报错，模拟真实请求被掐断。 */
function slowBody(total, signal, { chunk = 32 * 1024, delay = 20 } = {}) {
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

/** 把模型和词表都按「已经装好」摆好，让测试只跑关心的那一步。 */
async function presetModelAndTokens(paths) {
  await touchSized(paths.model, MODEL_BYTES);
  await touchSized(paths.tokens, TOKENS_BYTES);
}

/** 把 ffmpeg 摆好（够 20 兆，超过「大于 10 兆」那条线）。 */
async function presetFfmpeg(paths) {
  await touchSized(paths.ffmpeg, 20 * 1024 * 1024);
}

test("localEnvPaths：三样东西都落在临时家目录下的 local 里", () => {
  const home = path.join(TMP_BASE, "home-paths");
  const p = localEnvPaths({}, { home });
  assert.equal(p.root, path.join(home, "video-subtitle", "local"));
  assert.equal(p.bin, path.join(p.root, "bin"));
  assert.equal(p.ffmpeg, path.join(p.root, "bin", "ffmpeg.exe"));
  assert.equal(p.modelDir, path.join(p.root, "models", "sensevoice-onnx"));
  assert.equal(p.model, path.join(p.modelDir, "model.int8.onnx"));
  assert.equal(p.tokens, path.join(p.modelDir, "tokens.txt"));
  assert.equal(p.tmp, path.join(p.root, "tmp"));
});

test("localEnvPaths：配置里填了 ffmpegPath 就用用户自己指的那个", () => {
  const home = path.join(TMP_BASE, "home-cfg");
  const mine = path.join(home, "我的ffmpeg.exe");
  const p = localEnvPaths({ ffmpegPath: mine }, { home });
  assert.equal(p.ffmpeg, mine);
  // 其它几项不受影响
  assert.equal(p.model, path.join(home, "video-subtitle", "local", "models", "sensevoice-onnx", "model.int8.onnx"));
});

test("localStatus：三样都没有时报缺，缺什么写得清楚", () => {
  const home = path.join(TMP_BASE, "home-empty");
  const st = localStatus({}, { home });
  assert.equal(st.ready, false);
  assert.equal(st.items.length, 3);
  assert.deepEqual(st.items.map((x) => x.id), ["ffmpeg", "model", "tokens"]);
  assert.deepEqual(st.items.map((x) => x.label), ["FFmpeg（从视频里抽出声音）", "SenseVoice 模型", "SenseVoice 模型词表"]);
  assert.ok(st.items.every((x) => x.present === false));
  assert.deepEqual(st.missing, ["FFmpeg（从视频里抽出声音）", "SenseVoice 模型（约 239 兆）", "SenseVoice 模型词表"]);
  assert.equal(st.root, path.join(home, "video-subtitle", "local"));
});

test("localStatus：文件在但只有一小截，不算有", async () => {
  const home = path.join(TMP_BASE, "home-half");
  const p = localEnvPaths({}, { home });
  // 模型只下了一半：按一半的界线，刚够但这里故意再少一点
  await touchSized(p.model, 100 * 1024 * 1024);
  await touchSized(p.tokens, 100);
  const st = localStatus({}, { home });
  assert.equal(st.ready, false);
  const model = st.items.find((x) => x.id === "model");
  const tokens = st.items.find((x) => x.id === "tokens");
  assert.equal(model.present, false);
  assert.equal(tokens.present, false);
  assert.match(model.detail, /还没下完/);
  assert.deepEqual(st.missing, ["FFmpeg（从视频里抽出声音）", "SenseVoice 模型（约 239 兆）", "SenseVoice 模型词表"]);
});

test("localStatus：三样都够大才说能用", async () => {
  const home = path.join(TMP_BASE, "home-ok");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await presetModelAndTokens(p);
  const st = localStatus({}, { home });
  assert.equal(st.ready, true);
  assert.deepEqual(st.missing, []);
  assert.ok(st.items.every((x) => x.present));
});

test("一键安装：全新下载走 200，本地已有的步骤标成跳过", async () => {
  const home = path.join(TMP_BASE, "home-200");
  const p = localEnvPaths({}, { home });
  // ffmpeg 和模型先摆好，只有词表要下
  await presetFfmpeg(p);
  await touchSized(p.model, MODEL_BYTES);

  const fetchImpl = makeFetch(({ url }) => {
    if (url.includes("tokens.txt")) return res200(filler(TOKENS_BYTES), { "content-length": String(TOKENS_BYTES) });
    throw new Error("这个测试不该去请求 " + url);
  });

  const r = await startLocalSetup({}, { fetchImpl, home });
  assert.equal(r.started, true);
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  const step = (id) => st.steps.find((s) => s.id === id);
  assert.equal(step("ffmpeg").state, "skipped");
  assert.equal(step("model").state, "skipped");
  assert.equal(step("tokens").state, "done");
  assert.equal(step("verify").state, "done");
  assert.equal(statSync(p.tokens).size, TOKENS_BYTES);
  assert.match(step("ffmpeg").detail, /本地已有，跳过/);
});

test("一键安装：本地有半截文件时用 Range 续传，落盘大小对得上", async () => {
  const home = path.join(TMP_BASE, "home-206");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await touchSized(p.model, MODEL_BYTES);
  // 词表已经下了 10 万字节
  const had = 100000;
  await fs.mkdir(p.tmp, { recursive: true });
  await fs.writeFile(path.join(p.tmp, "tokens.txt.part"), filler(had));

  const fetchImpl = makeFetch(({ url, headers }) => {
    if (!url.includes("tokens.txt")) throw new Error("不该请求 " + url);
    assert.equal(headers.range, "bytes=" + had + "-", "续传要带上 Range");
    const rest = filler(TOKENS_BYTES - had, 0x63);
    return new Response(rest, {
      status: 206,
      headers: {
        "content-range": "bytes " + had + "-" + (TOKENS_BYTES - 1) + "/" + TOKENS_BYTES,
        "content-length": String(rest.length),
      },
    });
  });

  await startLocalSetup({}, { fetchImpl, home });
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  assert.equal(statSync(p.tokens).size, TOKENS_BYTES);
  const tokens = st.steps.find((s) => s.id === "tokens");
  assert.equal(tokens.bytesDone, TOKENS_BYTES);
  assert.equal(tokens.bytesTotal, TOKENS_BYTES);
});

test("一键安装：半截文件其实已经下满（服务器回 416）也认，不白下第二遍", async () => {
  const home = path.join(TMP_BASE, "home-416");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await touchSized(p.model, MODEL_BYTES);
  await fs.mkdir(p.tmp, { recursive: true });
  const part = path.join(p.tmp, "tokens.txt.part");
  await fs.writeFile(part, filler(TOKENS_BYTES));

  const fetchImpl = makeFetch(({ url }) => {
    if (!url.includes("tokens.txt")) throw new Error("不该请求 " + url);
    return new Response("range not satisfiable", { status: 416 });
  });

  await startLocalSetup({}, { fetchImpl, home });
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  assert.equal(statSync(p.tokens).size, TOKENS_BYTES);
});

test("一键安装：安装包地址跳转以后也能下到，并把 exe 从包里解出来", async () => {
  const home = path.join(TMP_BASE, "home-302");
  const p = localEnvPaths({}, { home });
  await presetModelAndTokens(p);

  const zip = wheelWithFfmpeg();
  const fetchImpl = makeFetch(({ url }) => {
    if (url.includes("/simple/imageio-ffmpeg/")) {
      const html =
        '<a href="../../packages/aa/bb/imageio_ffmpeg-0.5.1-py3-none-win_amd64.whl#sha256=deadbeef">old</a>' +
        '<a href="https://pypi.tuna.tsinghua.edu.cn/packages/cc/dd/imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl#sha256=ff">new</a>';
      return res200(html);
    }
    if (url.includes("cdn.example.com")) return res200(zip, { "content-length": String(zip.length) });
    if (url.includes("imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl")) {
      // 真实下载站会先跳到实际文件地址
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.com/files/imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl" },
      });
    }
    throw new Error("这个测试不该去请求 " + url);
  });

  const started = await startLocalSetup({}, { fetchImpl, home });
  assert.equal(started.started, true);
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  assert.equal(st.steps.find((s) => s.id === "ffmpeg").state, "done");
  assert.ok(existsSync(p.ffmpeg), "ffmpeg 应该被解出来");
  assert.ok(statSync(p.ffmpeg).size > 10 * 1024 * 1024, "解出来的 ffmpeg 要大于 10 兆");
  assert.equal(localStatus({}, { home }).ready, true);
  // 安装包拿到以后要清掉，别留垃圾
  assert.equal(existsSync(path.join(p.tmp, "imageio_ffmpeg.whl.part")), false);
});

test("一键安装：装错了安装包（里面没有 exe）要明确报错", async () => {
  const home = path.join(TMP_BASE, "home-noexe");
  const p = localEnvPaths({}, { home });
  await presetModelAndTokens(p);

  const zip = buildZip([{ name: "imageio_ffmpeg/__init__.py", data: "print('hi')" }]);
  const fetchImpl = makeFetch(() => res200(zip, { "content-length": String(zip.length) }));

  await startLocalSetup({}, { fetchImpl, home });
  const st = await waitIdle();
  assert.equal(st.ok, false);
  const step = st.steps.find((s) => s.id === "ffmpeg");
  assert.equal(step.state, "failed");
  assert.match(step.detail, /没有 ffmpeg/);
  assert.equal(existsSync(p.ffmpeg), false);
});

test("一键安装：网络失败会自动重试，第二次成功", async () => {
  const home = path.join(TMP_BASE, "home-retry");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await touchSized(p.model, MODEL_BYTES);

  let hits = 0;
  const fetchImpl = makeFetch(({ url }) => {
    if (!url.includes("tokens.txt")) throw new Error("不该请求 " + url);
    hits += 1;
    if (hits === 1) return new Response("boom", { status: 500 });
    return res200(filler(TOKENS_BYTES), { "content-length": String(TOKENS_BYTES) });
  });

  await startLocalSetup({}, { fetchImpl, home });
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  assert.equal(hits, 2, "失败一次后应该自己再试一次");
  assert.ok(st.log.some((line) => /重试/.test(line)), "日志里要说明在重试");
  assert.equal(statSync(p.tokens).size, TOKENS_BYTES);
});

test("一键安装：一直失败就说清是哪一样没下来，并写主机名", async () => {
  const home = path.join(TMP_BASE, "home-dead");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await touchSized(p.model, MODEL_BYTES);

  let hits = 0;
  const fetchImpl = makeFetch(({ url }) => {
    if (!url.includes("tokens.txt")) throw new Error("不该请求 " + url);
    hits += 1;
    return new Response("boom", { status: 503 });
  });

  await startLocalSetup({}, { fetchImpl, home });
  const st = await waitIdle(30000);
  assert.equal(st.ok, false);
  assert.equal(hits, 3, "最多试 3 次");
  assert.match(st.error, /模型词表/);
  assert.match(st.error, /hf-mirror\.com/, "错误里要写清是哪个站");
  assert.doesNotMatch(st.error, /https?:\/\//, "错误里不该出现完整下载地址");
  const step = st.steps.find((s) => s.id === "tokens");
  assert.equal(step.state, "failed");
  assert.equal(st.steps.find((s) => s.id === "verify").state, "pending");
});

test("取消安装：正在下的请求真的被掐断，状态是失败且说明已取消", async () => {
  const home = path.join(TMP_BASE, "home-cancel");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await touchSized(p.model, MODEL_BYTES);

  let sawAbort = false;
  const fetchImpl = makeFetch(({ url, signal, call }) => {
    if (!url.includes("tokens.txt")) throw new Error("不该请求 " + url);
    signal.addEventListener?.("abort", () => {
      sawAbort = true;
    }, { once: true });
    return res200(slowBody(TOKENS_BYTES, signal), { "content-length": String(TOKENS_BYTES) });
  });

  const started = await startLocalSetup({}, { fetchImpl, home });
  assert.equal(started.started, true);

  // 等它真开始写文件再取消
  const t0 = Date.now();
  while (!existsSync(path.join(p.tmp, "tokens.txt.part")) || statSync(path.join(p.tmp, "tokens.txt.part")).size === 0) {
    if (Date.now() - t0 > 8000) throw new Error("等不到下载开始的迹象");
    await sleep(20);
  }
  const c = cancelLocalSetup();
  assert.equal(c.cancelled, true);
  const st = await waitIdle();
  assert.equal(st.ok, false);
  assert.equal(st.error, "安装已取消");
  assert.equal(st.steps.find((s) => s.id === "tokens").state, "failed");
  assert.equal(sawAbort, true, "取消必须真的停掉请求");
  // 半截文件留着，下次接着下
  assert.ok(statSync(path.join(p.tmp, "tokens.txt.part")).size > 0);
  assert.equal(existsSync(p.tokens), false);
  assert.equal(cancelLocalSetup().cancelled, false, "没任务在跑时取消就什么都不做");
});

test("任务状态：四个步骤的 id 和中文名字都是固定的", async () => {
  const home = path.join(TMP_BASE, "home-steps");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await presetModelAndTokens(p);
  const fetchImpl = makeFetch(() => {
    throw new Error("三样都有，不该联网");
  });
  await startLocalSetup({}, { fetchImpl, home });
  const st = await waitIdle();
  assert.equal(st.ok, true, st.error || "");
  assert.deepEqual(st.steps.map((s) => s.id), ["ffmpeg", "model", "tokens", "verify"]);
  assert.deepEqual(st.steps.map((s) => s.label), [
    "FFmpeg（从视频里抽出声音）",
    "下载 SenseVoice 模型",
    "下载 SenseVoice 模型词表",
    "复查能不能用",
  ]);
  for (const s of st.steps) {
    assert.ok(["pending", "running", "done", "failed", "skipped"].includes(s.state));
    assert.equal(typeof s.bytesDone, "number");
    assert.equal(typeof s.bytesTotal, "number");
  }
  assert.ok(st.log.length > 0, "日志里要写清干了什么");
});

test("重复点安装：已经在跑就返回同一个任务号", async () => {
  const home = path.join(TMP_BASE, "home-twice");
  const p = localEnvPaths({}, { home });
  await presetFfmpeg(p);
  await touchSized(p.model, MODEL_BYTES);

  const fetchImpl = makeFetch(({ url, signal }) => {
    if (!url.includes("tokens.txt")) throw new Error("不该请求 " + url);
    return res200(slowBody(TOKENS_BYTES, signal), { "content-length": String(TOKENS_BYTES) });
  });
  const a = await startLocalSetup({}, { fetchImpl, home });
  const b = await startLocalSetup({}, { fetchImpl, home });
  assert.equal(b.started, false);
  assert.equal(b.taskId, a.taskId);
  cancelLocalSetup();
  await waitIdle();
});
