/**
 * 本机识别环境（SenseVoice）的安装位置、体检与一键安装。
 *
 * 为什么要这个文件：local 这条字幕来源不要 Python，转写也不联网，缺的只有三样——
 * 从视频里抽声音的 ffmpeg、SenseVoice 模型、以及模型词表。以前这三样靠用户自己
 * 从各处凑，界面上就一直灰着。这里把「插件自己的正式安装位置」定下来，再给出
 * 体检和一键安装，一次装齐，装完复查一遍。
 *
 * 正式位置（插件自己管，删掉这个目录就等于把识别环境整个卸掉）：
 *   <DSH_HOME>/video-subtitle/local/bin/ffmpeg.exe                         从视频里抽声音的工具
 *   <DSH_HOME>/video-subtitle/local/models/sensevoice-onnx/model.int8.onnx 语音识别模型
 *   <DSH_HOME>/video-subtitle/local/models/sensevoice-onnx/tokens.txt      模型词表
 *   <DSH_HOME>/video-subtitle/local/tmp/                                   下载中的半截文件
 *
 * 三样都不要 Python：ffmpeg 直接从 imageio-ffmpeg 的 Windows 安装包里解出来，
 * 模型和词表从国内镜像整份下回来。下载支持断点续传，取消以后半截文件留着，下次接着下。
 *
 * 安装任务全局只有一个，重复点安装拿到的是同一个任务号。日志一律脱敏，用户名、
 * 用户目录、带签名的完整下载地址都不会露出来。
 */
import { createReadStream, createWriteStream, statSync, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import path from "node:path";
import os from "node:os";

/** 清华镜像上的安装包列表页，版本号从这里现找，不写死。 */
const WHEEL_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/imageio-ffmpeg/";
/** 列表页解析不出来时的备选直链（实测能用，版本会旧，只当兜底）。 */
const WHEEL_FALLBACK_URL =
  "https://pypi.tuna.tsinghua.edu.cn/packages/2c/c6/fa760e12a2483469e2bf5058c5faff664acf66cadb4df2ad6205b016a73d/imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl";
/** SenseVoice 模型和词表所在的仓库，走国内镜像，会先跳转到实际下载地址。 */
const HF_ROOT = "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main";
const MODEL_URL = HF_ROOT + "/model.int8.onnx";
const TOKENS_URL = HF_ROOT + "/tokens.txt";
/** 模型和词表的准确字节数，下完拿它对账，差一个字节都不算下完。 */
const MODEL_BYTES = 239233841;
const TOKENS_BYTES = 315894;
/** ffmpeg 每个版本大小都不一样，只认「解出来大于 10 兆」，不写死总大小。 */
const MIN_FFMPEG_BYTES = 10 * 1024 * 1024;
/** 体检时的预期大小：取两倍，一半正好是 10 兆的底线，跟上面那条对齐。 */
const FFMPEG_EXPECTED_BYTES = MIN_FFMPEG_BYTES * 2;
/** 网络失败重试的等待时间，依次 1 秒、3 秒，也就是最多试 3 次。 */
const RETRY_DELAYS = [1000, 3000];
/** 日志最多留这么多行，防止装很久的机器把内存撑爆。 */
const LOG_LIMIT = 400;
/** 进度里一兆按多少字节算（跟下载站标注的口径一致）。 */
const MB = 1000 * 1000;

/** 安装的四个步骤，顺序固定。 */
const STEPS = [
  { id: "ffmpeg", label: "FFmpeg（从视频里抽出声音）" },
  { id: "model", label: "下载 SenseVoice 模型" },
  { id: "tokens", label: "下载 SenseVoice 模型词表" },
  { id: "verify", label: "复查能不能用" },
];

/**
 * 体检时挨个看的三个文件。bytes 是「预期多大」：
 * 先按这个的一半当「有」，所以 ffmpeg 的底线正好落在 10 兆上。
 * missing 是缺这一样时给用户看的人话。
 */
const ITEMS = [
  { id: "ffmpeg", label: "FFmpeg（从视频里抽出声音）", bytes: FFMPEG_EXPECTED_BYTES, missing: "FFmpeg（从视频里抽出声音）" },
  { id: "model", label: "SenseVoice 模型", bytes: MODEL_BYTES, missing: "SenseVoice 模型（约 239 兆）" },
  { id: "tokens", label: "SenseVoice 模型词表", bytes: TOKENS_BYTES, missing: "SenseVoice 模型词表" },
];

/** DSH 的家目录：优先听环境变量，没有就用用户目录下的 .dsh。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/**
 * 算出一套路径。第二个参数 home 只给测试用，可以临时把「家目录」指到别处，
 * 免得测试去碰真实环境。
 *
 * ffmpeg 优先用配置里自己指的 ffmpegPath；没指就用插件自己装的那份，
 * 也就是 local/bin/ffmpeg.exe。其余几项都在 local 这棵树下面，不受配置影响。
 */
export function localEnvPaths(cfg = {}, { home } = {}) {
  const base = home || dshHome();
  const root = path.join(base, "video-subtitle", "local");
  const bin = path.join(root, "bin");
  const modelDir = path.join(root, "models", "sensevoice-onnx");
  const configured = String(cfg?.ffmpegPath || "").trim();
  return {
    root,
    bin,
    ffmpeg: configured || path.join(bin, "ffmpeg.exe"),
    modelDir,
    model: path.join(modelDir, "model.int8.onnx"),
    tokens: path.join(modelDir, "tokens.txt"),
    tmp: path.join(root, "tmp"),
  };
}

/** 文件有多大；不存在或者不是普通文件都返回 -1。 */
function sizeOnDisk(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/** 「12.3」这种兆数，日志和界面都用它。 */
function mbText(bytes) {
  return (Math.max(0, Number(bytes) || 0) / MB).toFixed(1);
}

/**
 * 查环境：三样东西在不在、够不够大。同步函数，不碰网络，设置页可以随时调。
 * 三样全都有才叫 ready。missing 里是缺什么的人话，直接能显示给用户。
 */
export function localStatus(cfg = {}, { home } = {}) {
  const p = localEnvPaths(cfg, { home });
  const items = ITEMS.map((it) => {
    const file = p[it.id];
    const size = sizeOnDisk(file);
    const present = size >= Math.ceil(it.bytes / 2);
    let detail;
    if (present) {
      detail = "已经装好，可以用";
    } else if (size < 0) {
      detail = "还没准备好，点一键安装会自动下载";
    } else {
      detail = "文件只有 " + mbText(size) + " 兆，还没下完，点一键安装会接着下";
    }
    return { id: it.id, label: it.label, bytes: it.bytes, path: file, present, detail };
  });
  const missing = items.filter((it) => !it.present).map((it) => ITEMS.find((x) => x.id === it.id).missing);
  return { ready: missing.length === 0, items, missing, root: p.root };
}

/** 把话里的用户名、用户目录、带查询串的下载地址抹掉。日志和报错一律先过这一道。 */
function redact(text) {
  let s = String(text ?? "");
  if (!s) return s;
  const homes = [os.homedir(), process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  for (const h of homes) s = s.split(h).join("<用户目录>");
  s = s.replace(/([A-Za-z]:\\Users\\)[^\\\r\n"'<>|]+/g, "$1<用户目录>");
  s = s.replace(/([A-Za-z]:\/Users\/)[^/\r\n"'<>|]+/g, "$1<用户目录>");
  // 下载地址只留到路径，查询串可能带签名，一律砍掉。
  s = s.replace(/https?:\/\/[^\s"'<>）)]+/g, (m) => m.split("?")[0]);
  return s;
}

/** 下载地址的主机名，报错只说到这一层，不把完整地址打出去。 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "下载站";
  }
}

/* ------------------------------------------------------------------ *
 * 安装任务状态：全局只有一个任务，进度靠 localSetupState() 读。
 * ------------------------------------------------------------------ */

/** 全局唯一的安装任务状态。 */
let state = blankState();
/** 当前这次任务的现场：任务号、取消标记、中断器、日志出口。 */
let current = null;
/** 任务号自增，避免同一毫秒内两次启动撞号。 */
let taskSeq = 0;

function blankState() {
  return {
    taskId: null,
    running: false,
    ok: null,
    currentStep: null,
    steps: STEPS.map((s) => ({
      id: s.id,
      label: s.label,
      state: "pending",
      detail: "还没开始",
      bytesDone: 0,
      bytesTotal: 0,
      percent: 0,
    })),
    log: [],
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

/** 把一行写进任务日志：先脱敏，再限制总行数。 */
function pushLog(line) {
  const text = redact(line);
  state.log.push(text);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  try {
    current?.logSink?.(text);
  } catch {
    /* 外部日志回调出错不影响安装 */
  }
}

/** 看一眼当前安装任务。返回的是副本，外面改不到内部状态。 */
export function localSetupState() {
  return {
    ...state,
    steps: state.steps.map((s) => ({ ...s })),
    log: state.log.slice(),
  };
}

/** 停掉正在跑的安装。没任务在跑就返回 cancelled:false。 */
export function cancelLocalSetup() {
  if (!state.running || !current) return { cancelled: false };
  current.token.cancelled = true;
  try {
    current.controller.abort();
  } catch {
    /* 已经停了 */
  }
  const running = state.steps.find((s) => s.state === "running");
  if (running) {
    running.state = "failed";
    running.detail = "已取消";
  }
  state.running = false;
  state.ok = false;
  state.currentStep = null;
  state.finishedAt = Date.now();
  state.error = "安装已取消";
  pushLog("安装已取消，已经下了一半的文件留着，下次点安装会接着下");
  return { cancelled: true };
}

/**
 * 开始一键安装。立刻返回任务号，真正干活在后台跑，进度看 localSetupState()。
 * 已经有一个在跑就返回现有的任务号（started 为 false）。
 * fetchImpl 只给测试用，平时用全局 fetch。
 */
export async function startLocalSetup(cfg = {}, { fetchImpl, log, home } = {}) {
  if (state.running && current) return { started: false, taskId: state.taskId };

  taskSeq += 1;
  const taskId = "local-setup-" + Date.now().toString(36) + "-" + taskSeq;
  const token = { cancelled: false };
  const controller = new AbortController();
  current = { taskId, token, controller, logSink: typeof log === "function" ? log : null };
  state = blankState();
  state.taskId = taskId;
  state.running = true;
  state.startedAt = Date.now();
  state.currentStep = STEPS[0].id;

  const options = {
    fetchImpl: typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch,
    home,
    token,
    signal: controller.signal,
  };
  // 后台跑，不占着调用方；万一整段代码炸了也别让状态永远挂着「正在跑」。
  runSetup(taskId, cfg && typeof cfg === "object" ? cfg : {}, options).catch((e) => {
    if (state.taskId !== taskId || !state.running) return;
    state.running = false;
    state.ok = false;
    state.finishedAt = Date.now();
    state.currentStep = null;
    state.error = redact(e?.message || String(e));
    pushLog("安装过程出了意外：" + state.error);
  });
  return { started: true, taskId };
}

function cancelledError() {
  const e = new Error("安装已取消");
  e.cancelled = true;
  return e;
}

function isCancelled(e) {
  return Boolean(e?.cancelled);
}

function isAbort(e, signal) {
  if (signal?.aborted) return true;
  const name = String(e?.name || "");
  const code = String(e?.code || "");
  return name === "AbortError" || name === "CanceledError" || code === "ABORT_ERR";
}

/** 等一会儿；中途取消就不再傻等。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

/** 网络失败重试：最多试 3 次，间隔依次 1 秒、3 秒。取消或明确不该重试就立刻停。 */
async function withRetry(work, { label, say, signal }) {
  let lastErr = null;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try {
      return await work();
    } catch (e) {
      if (isCancelled(e) || isAbort(e, signal)) throw cancelledError();
      lastErr = e;
      if (e?.retryable === false) throw e;
      if (i >= RETRY_DELAYS.length) break;
      const wait = RETRY_DELAYS[i];
      say(label + "这次没成功：" + redact(e?.message || String(e)) + "；" + Math.round(wait / 1000) + " 秒后重试");
      await sleep(wait, signal);
      if (signal?.aborted) throw cancelledError();
    }
  }
  throw lastErr;
}

/** 请求一个地址，自己处理跳转（真实 fetch 本来也会跟，这里兜住注入进来的假实现）。 */
async function fetchFollow(fetchImpl, url, options, signal, hops = 0) {
  const res = await fetchImpl(url, { ...options, redirect: "follow", signal });
  const status = Number(res?.status || 0);
  const location = res?.headers?.get?.("location");
  if (status >= 300 && status < 400 && location && hops < 8) {
    const next = new URL(String(location), url).toString();
    return fetchFollow(fetchImpl, next, options, signal, hops + 1);
  }
  return res;
}

function httpError(status, url) {
  const host = hostOf(url);
  const e = new Error(host + " 返回 " + (status || "未知状态"));
  e.status = Number(status) || 0;
  e.host = host;
  // 4xx 是地址或权限的问题，重试也没用；408、429 和 5xx 值得再试。
  e.retryable = !(e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);
  return e;
}

/** 从列表页里挑最新的一版 win_amd64 安装包。挑不到返回空串。 */
function pickLatestWheel(html) {
  const re = /href="([^"]*?imageio_ffmpeg-[^"]*?-py3-none-win_amd64\.whl[^"]*)"/gi;
  const found = [];
  let m;
  while ((m = re.exec(String(html || "")))) {
    let href = m[1];
    const hash = href.indexOf("#");
    if (hash >= 0) href = href.slice(0, hash);
    let url;
    try {
      url = new URL(href, WHEEL_INDEX_URL).toString();
    } catch {
      continue;
    }
    const name = url.split("/").pop() || "";
    const vm = /^imageio_ffmpeg-([0-9][^-]*)-py3-none-win_amd64\.whl$/i.exec(name);
    if (!vm) continue;
    const version = vm[1].split(".").map((n) => Number(n) || 0);
    found.push({ url, version });
  }
  found.sort((a, b) => {
    const len = Math.max(a.version.length, b.version.length);
    for (let i = 0; i < len; i++) {
      const d = (a.version[i] || 0) - (b.version[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return found.length ? found[found.length - 1].url : "";
}

/** 去镜像站现找安装包地址；列表页打不开就退回记下来的那个直链。 */
async function resolveWheelUrl(fetchImpl, signal, say) {
  try {
    const html = await withRetry(
      async () => {
        const res = await fetchFollow(fetchImpl, WHEEL_INDEX_URL, {}, signal);
        const status = Number(res?.status || 0);
        if (status !== 200) throw httpError(status, WHEEL_INDEX_URL);
        return await res.text();
      },
      { label: "安装包列表", say, signal },
    );
    const picked = pickLatestWheel(html);
    if (picked) {
      say("找到最新的 Windows 安装包：" + picked.split("/").pop());
      return picked;
    }
    say("安装包列表里没看到能用的那一条，改用记下来的备选地址");
  } catch (e) {
    if (isCancelled(e)) throw e;
    say("安装包列表打不开（" + redact(e?.message || String(e)) + "），改用记下来的备选地址");
  }
  return WHEEL_FALLBACK_URL;
}

/** 更新某一步的进度。界面每秒轮询一次，这里只写数字，不做别的重活。 */
function noteProgress(step, done, total) {
  step.bytesDone = done;
  step.bytesTotal = total > 0 ? total : 0;
  step.percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
}

/**
 * 下一次：写到 xxx.part，能续就续，每次最多试 3 次。
 * 返回 { bytes } 表示最后落在盘上是多少字节。
 */
async function downloadFile({ url, partPath, label, expected = 0, fetchImpl, signal, say, step }) {
  const result = await withRetry(() => attemptDownload({ url, partPath, label, expected, fetchImpl, signal, say, step }), {
    label,
    say,
    signal,
  }).catch((e) => {
    if (isCancelled(e)) throw e;
    throw new Error(label + "没下来：" + redact(e?.message || String(e)) + "。检查一下网络再重新点一次一键安装");
  });
  return result;
}

async function attemptDownload({ url, partPath, label, expected, fetchImpl, signal, say, step }) {
  const offset = Math.max(0, sizeOnDisk(partPath));
  const headers = {
    // 一律要原样字节，避免服务器压过一道以后大小对不上。
    "Accept-Encoding": "identity",
  };
  if (offset > 0) headers.Range = "bytes=" + offset + "-";

  let res;
  try {
    res = await fetchFollow(fetchImpl, url, { headers }, signal);
  } catch (e) {
    if (isCancelled(e) || isAbort(e, signal)) throw cancelledError();
    const host = hostOf(url);
    const reason = redact(e?.message || String(e)).slice(0, 80);
    const wrapped = new Error("连不上 " + host + (reason ? "（" + reason + "）" : ""));
    wrapped.retryable = true;
    throw wrapped;
  }

  const status = Number(res?.status || 0);
  // 416：上次其实已经下满了，只是没来得及改名。大小对得上就直接当它下完。
  if (status === 416) {
    if (expected && offset === expected) return { bytes: offset };
    await fs.rm(partPath, { force: true });
    const e = new Error("接着下的位置服务器不认，已经删掉半截文件从头下载");
    e.retryable = true;
    throw e;
  }
  if (status !== 200 && status !== 206) throw httpError(status, url);

  let start = offset;
  let total = 0;
  if (status === 206) {
    // 续传：总长度从 Content-Range 的斜杠后面读，那是文件完整的大小。
    const cr = String(res?.headers?.get?.("content-range") || "").trim();
    const range = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(cr);
    if (range) {
      const from = Number(range[1]);
      if (from !== offset) {
        // 服务器给的起点和我们手里的半截对不上，删掉重来，别拼出一个坏文件。
        await fs.rm(partPath, { force: true });
        const e = new Error("续传的位置对不上，已经删掉半截文件从头下载");
        e.retryable = true;
        throw e;
      }
      total = range[3] === "*" ? 0 : Number(range[3]);
    }
  } else {
    // 200：服务器不支持接着下，旧的一截作废，从头写。
    if (offset > 0) say(label + "：服务器不支持接着下，从头开始");
    start = 0;
    total = Number(res?.headers?.get?.("content-length") || 0);
  }
  if (!total && status === 206) {
    total = Number(res?.headers?.get?.("content-length") || 0) + offset;
  }
  if (!total && expected) total = expected;

  const reader = res?.body?.getReader?.();
  if (!reader) throw new Error("服务器没有返回文件内容");

  await fs.mkdir(path.dirname(partPath), { recursive: true });
  const fh = await fs.open(partPath, start > 0 ? "a" : "w");
  let done = start;
  // 每跨过 10% 才写一行日志，别一个数据块写一行。
  let bucketLogged = total > 0 ? Math.floor((start / total) * 10) : Math.floor(start / (64 * MB));
  try {
    for (;;) {
      if (signal?.aborted) throw cancelledError();
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (!value || !value.length) continue;
      await fh.write(value);
      done += value.length;
      noteProgress(step, done, total);
      const bucket = total > 0 ? Math.floor((done / total) * 10) : Math.floor(done / (64 * MB));
      if (bucket > bucketLogged) {
        bucketLogged = bucket;
        say(
          total > 0
            ? label + "：已下 " + mbText(done) + " 兆 / 共 " + mbText(total) + " 兆"
            : label + "：已下 " + mbText(done) + " 兆",
        );
      }
    }
  } catch (e) {
    if (isCancelled(e) || isAbort(e, signal)) throw cancelledError();
    throw e;
  } finally {
    await fh.close().catch(() => {});
  }

  if (signal?.aborted) throw cancelledError();
  if (total > 0 && done !== total) {
    if (done > total) await fs.rm(partPath, { force: true });
    const e = new Error("只下了 " + mbText(done) + " 兆，应该 " + mbText(total) + " 兆，网络提前断了");
    e.retryable = true;
    throw e;
  }
  if (expected && done !== expected) {
    const e = new Error("下完是 " + done + " 字节，应该 " + expected + " 字节，对不上");
    e.retryable = false;
    throw e;
  }
  return { bytes: done };
}

/**
 * 在 zip（wheel 其实就是 zip）的中央目录里找到 ffmpeg 那个条目。
 * 只认 0x04034b50 本地文件头与 0x02014b50 中央目录，不认 zip64。
 */
async function findZipEntry(file, matcher) {
  const fh = await fs.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    if (size < 22) throw new Error("安装包是坏的（文件太短），删掉 local/tmp 里的半截文件再试一次");

    // 结尾记录后面可能跟注释，最长 65557 字节，从尾巴往前找。
    const tailLen = Math.min(size, 65557 + 22);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("安装包是坏的（找不到结尾记录），删掉 local/tmp 里的半截文件再试一次");

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (!count || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error("这个安装包的结构不是常见的格式，没法自己解开");
    }

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    let off = 0;
    for (let i = 0; i < count && off + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(off) !== 0x02014b50) break;
      const method = cd.readUInt16LE(off + 10);
      const compSize = cd.readUInt32LE(off + 20);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const localOff = cd.readUInt32LE(off + 42);
      const name = cd.toString("utf8", off + 46, off + 46 + nameLen);
      off += 46 + nameLen + extraLen + commentLen;
      if (!matcher.test(name)) continue;

      // 数据起点要按本地文件头里的文件名长度算，中央目录里的是另一份。
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("安装包是坏的（文件头对不上）");
      const dataStart = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      return { name, method, compSize, dataStart };
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 从 wheel 里把 ffmpeg 那个 exe 流式解出来。
 * 87 兆的东西不整个读进内存，边读边解边写，内存里只有一小块。
 */
async function extractFfmpeg(wheelPath, outPath, { signal, say }) {
  const entry = await findZipEntry(wheelPath, /imageio_ffmpeg\/binaries\/ffmpeg.*\.exe$/i);
  if (!entry) throw new Error("安装包解开以后里面没有 ffmpeg 程序，这个安装包可能不对");
  if (!entry.compSize) throw new Error("安装包里的 ffmpeg 是空的，这个安装包可能不对");
  if (signal?.aborted) throw cancelledError();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const from = entry.dataStart;
  const to = entry.dataStart + entry.compSize - 1;
  if (entry.method === 0) {
    await pipeline(createReadStream(wheelPath, { start: from, end: to }), createWriteStream(outPath));
  } else if (entry.method === 8) {
    await pipeline(
      createReadStream(wheelPath, { start: from, end: to }),
      createInflateRaw(),
      createWriteStream(outPath),
    );
  } else {
    throw new Error("安装包里的 ffmpeg 用了不认识的压缩方式（" + entry.method + "），换一个安装包再试");
  }
  if (signal?.aborted) throw cancelledError();
  say("已经从安装包里取出 ffmpeg（" + entry.name.split("/").pop() + "）");
  return entry;
}

/** 三样都真的齐了才算数：ffmpeg 大于 10 兆，模型和词表不小于应有的字节数。 */
function completeEnough(id, file) {
  const size = sizeOnDisk(file);
  if (id === "ffmpeg") return size > MIN_FFMPEG_BYTES;
  if (id === "model") return size >= MODEL_BYTES;
  return size >= TOKENS_BYTES;
}

async function runSetup(taskId, cfg, { fetchImpl, home, token, signal }) {
  const paths = localEnvPaths(cfg, { home });
  // 取消是按任务记的：点取消那一刻可能已经换过任务号，这里必须用启动时那一份。
  const alive = () => state.taskId === taskId && !token.cancelled;
  const say = (line) => {
    if (state.taskId === taskId) pushLog(line);
  };
  const stepOf = (id) => state.steps.find((s) => s.id === id);

  /** 跑一步：成功标 done，本地已有标 skipped，失败标 failed 并把整个任务收掉。 */
  const runStep = async (id, fn) => {
    if (!alive()) return false;
    const s = stepOf(id);
    state.currentStep = id;
    s.state = "running";
    s.detail = "正在做";
    say("【" + s.label + "】开始");
    try {
      const outcome = await fn(s);
      if (outcome === "skipped") {
        s.state = "skipped";
        s.detail = "本地已有，跳过";
        say("【" + s.label + "】本地已有，跳过");
        return true;
      }
    } catch (e) {
      const cancelledNow = isCancelled(e) || token.cancelled;
      const reason = cancelledNow ? "安装已取消" : redact(e?.message || String(e));
      s.state = "failed";
      s.detail = cancelledNow ? "已取消" : reason;
      if (state.taskId === taskId && !token.cancelled) {
        state.running = false;
        state.currentStep = null;
        state.ok = false;
        state.error = reason;
        state.finishedAt = Date.now();
        say("【" + s.label + "】失败：" + reason);
      }
      throw e;
    }
    s.state = "done";
    say("【" + s.label + "】完成");
    return true;
  };

  try {
    // 第一步：ffmpeg（下安装包，再从里面把 exe 解出来）
    await runStep("ffmpeg", async (s) => {
      if (completeEnough("ffmpeg", paths.ffmpeg)) return "skipped";
      say("去清华镜像找 imageio-ffmpeg 的 Windows 安装包");
      const url = await resolveWheelUrl(fetchImpl, signal, say);
      const wheelPath = path.join(paths.tmp, "imageio_ffmpeg.whl.part");
      await downloadFile({
        url,
        partPath: wheelPath,
        label: "从视频里抽声音的工具",
        fetchImpl,
        signal,
        say,
        step: s,
      });
      say("安装包下好了，正在从里面取出 ffmpeg 程序");
      const exePart = path.join(paths.tmp, "ffmpeg.exe.part");
      await extractFfmpeg(wheelPath, exePart, { signal, say });
      const size = sizeOnDisk(exePart);
      if (size <= MIN_FFMPEG_BYTES) {
        throw new Error("从视频里抽声音的工具解开以后只有 " + mbText(size) + " 兆，不像完整的，重新点一次一键安装");
      }
      await fs.mkdir(paths.bin, { recursive: true });
      await fs.rm(paths.ffmpeg, { force: true });
      await fs.rename(exePart, paths.ffmpeg);
      await fs.rm(wheelPath, { force: true });
      s.detail = "已经放好，能用";
      say("从视频里抽声音的工具准备好了，共 " + mbText(size) + " 兆");
    });

    // 第二步：语音识别模型
    await runStep("model", async (s) => {
      if (completeEnough("model", paths.model)) return "skipped";
      say("开始下载语音识别模型（约 239 兆），支持断点续传");
      const part = path.join(paths.tmp, "model.int8.onnx.part");
      const r = await downloadFile({
        url: MODEL_URL,
        partPath: part,
        label: "语音识别模型",
        expected: MODEL_BYTES,
        fetchImpl,
        signal,
        say,
        step: s,
      });
      await fs.mkdir(paths.modelDir, { recursive: true });
      await fs.rm(paths.model, { force: true });
      await fs.rename(part, paths.model);
      s.detail = "已经放好，能用";
      say("语音识别模型下好了，共 " + mbText(r.bytes) + " 兆");
    });

    // 第三步：词表
    await runStep("tokens", async (s) => {
      if (completeEnough("tokens", paths.tokens)) return "skipped";
      say("开始下载模型词表");
      const part = path.join(paths.tmp, "tokens.txt.part");
      const r = await downloadFile({
        url: TOKENS_URL,
        partPath: part,
        label: "模型词表",
        expected: TOKENS_BYTES,
        fetchImpl,
        signal,
        say,
        step: s,
      });
      await fs.mkdir(paths.modelDir, { recursive: true });
      await fs.rm(paths.tokens, { force: true });
      await fs.rename(part, paths.tokens);
      s.detail = "已经放好，能用";
      say("模型词表下好了，共 " + mbText(r.bytes) + " 兆");
    });

    // 第四步：复查
    await runStep("verify", async (s) => {
      const bad = ITEMS.filter((it) => !completeEnough(it.id, paths[it.id]));
      if (bad.length) {
        throw new Error(
          "复查没通过：" + bad.map((it) => it.missing).join("、") + " 还没到位，重新点一次一键安装会补齐",
        );
      }
      s.detail = "三样都齐了，可以用了";
      say("三样都齐了，可以用了");
    });

    state.running = false;
    state.ok = true;
    state.currentStep = null;
    state.finishedAt = Date.now();
    say("SenseVoice 语音转字幕装好了，可以用了");
  } catch (e) {
    if (token.cancelled) {
      if (state.taskId === taskId && state.running) {
        state.running = false;
        state.ok = false;
        state.finishedAt = Date.now();
        state.currentStep = null;
        if (!state.error) state.error = "安装已取消";
      }
      return;
    }
    if (state.taskId === taskId && state.running) {
      state.running = false;
      state.ok = false;
      state.currentStep = null;
      state.finishedAt = Date.now();
      state.error = redact(e?.message || String(e));
      say("安装失败：" + state.error);
    }
  }
}
