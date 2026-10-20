/**
 * 下载器（yt-dlp）自己的安装位置、体检与一键安装。
 *
 * 为什么要这个文件：B站 以外的站没有现成接口，只能借一个现成的下载器去把站上自带的
 * 字幕取下来。这个下载器不能让用户手工下载、手工放到某个文件夹，所以它的正式安装位置
 * 由插件自己管，再给一个体检和「一键安装」。
 *
 * 正式位置（插件自己管，删掉这个目录就等于把下载器整个卸掉）：
 *   <DSH_HOME>/video-subtitle/ytdlp/bin/yt-dlp.exe   下载器本体
 *   <DSH_HOME>/video-subtitle/ytdlp/version.txt      装完复查时记下来的版本号
 *   <DSH_HOME>/video-subtitle/ytdlp/tmp/             下载中的半截文件与子进程临时目录
 *
 * 下载先走国内镜像，不成就走官方地址；支持断点续传，取消以后半截文件留着，下次接着下。
 * 装完用 exe --version 复查一遍，版本对得上才算装好。日志一律脱敏，用户名、用户目录、
 * 带查询串的地址都不会露出来。
 */
import { statSync, readFileSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

/** 国内镜像：把 github 地址套在自己的前缀后面，实测能下。 */
const MIRROR_URL = "https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
/** 官方地址：镜像不成就走它。 */
const OFFICIAL_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
/** 下载器每个版本大小都略有出入，只认「下完大于 5 兆」，不写死总字节数。 */
const MIN_BYTES = 5 * 1024 * 1024;
/** 网络失败重试的等待时间，依次 1 秒、3 秒，也就是最多试 3 次。 */
const RETRY_DELAYS = [1000, 3000];
/** 日志最多留这么多行，防止装很久的机器把内存撑爆。 */
const LOG_LIMIT = 400;
/** 进度里一兆按多少字节算（跟下载站标注的口径一致）。 */
const MB = 1000 * 1000;
/** 复查子进程最多等多久。 */
const VERIFY_TIMEOUT_MS = 30000;
/** 版本号长这样：2026.08.19。 */
const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}/;

/** 安装的两步，顺序固定。 */
const STEPS = [
  { id: "download", label: "下载下载器" },
  { id: "verify", label: "复查能不能用" },
];

/** DSH 的家目录：优先听环境变量，没有就用用户目录下的 .dsh。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/**
 * 算出一套路径。第二个参数 home 只给测试用，可以临时把「家目录」指到别处，
 * 免得测试去碰真实环境。
 *
 * exe 优先用配置里自己指的 ytdlpPath；没指就用插件自己装的那份。
 */
export function ytdlpEnvPaths(cfg = {}, { home } = {}) {
  const base = home || dshHome();
  const root = path.join(base, "video-subtitle", "ytdlp");
  const bin = path.join(root, "bin");
  const configured = String(cfg?.ytdlpPath || "").trim();
  return {
    root,
    bin,
    exe: configured || path.join(bin, "yt-dlp.exe"),
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

/** 读 root/version.txt 里记下来的版本号；没有就返回空串。 */
function readVersion(file) {
  try {
    const text = String(readFileSync(file, "utf8") || "").trim();
    return text.split(/\r?\n/)[0].trim();
  } catch {
    return "";
  }
}

/**
 * 查下载器：在不在、够不够大、装的是哪个版本。同步函数，不碰网络，设置页可以随时调。
 * 大于 5 兆才算装好；没下完的文件如实说出已经有多少兆。
 */
export function ytdlpStatus(cfg = {}, { home } = {}) {
  const p = ytdlpEnvPaths(cfg, { home });
  const size = sizeOnDisk(p.exe);
  const present = size >= MIN_BYTES;
  const version = readVersion(path.join(p.root, "version.txt"));
  let detail;
  if (present) {
    detail = version ? "已经装好，版本 " + version : "已经装好，可以用";
  } else if (size < 0) {
    detail = "还没装，点一键安装会自动下载";
  } else {
    detail = "文件只有 " + mbText(size) + " 兆，还没下完，点一键安装会接着下";
  }
  return { ready: present, exe: p.exe, present, bytes: size > 0 ? size : 0, version, detail };
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
 * 安装任务状态：全局只有一个任务，进度靠 ytdlpSetupState() 读。
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
export function ytdlpSetupState() {
  return {
    ...state,
    steps: state.steps.map((s) => ({ ...s })),
    log: state.log.slice(),
  };
}

/** 停掉正在跑的安装。没任务在跑就返回 cancelled:false。 */
export function cancelYtdlpSetup() {
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
  pushLog("已经下了一半的文件留着，下次点安装会接着下");
  return { cancelled: true };
}

/**
 * 开始一键安装。立刻返回任务号，真正干活在后台跑，进度看 ytdlpSetupState()。
 * 已经有一个在跑就返回现有的任务号（started 为 false）。
 * fetchImpl、home、spawnFn 只给测试用，平时用全局 fetch 与真子进程。
 */
export async function startYtdlpSetup(cfg = {}, { fetchImpl, log, home, spawnFn } = {}) {
  if (state.running && current) return { started: false, taskId: state.taskId };

  taskSeq += 1;
  const taskId = "ytdlp-setup-" + Date.now().toString(36) + "-" + taskSeq;
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
    spawnFn: typeof spawnFn === "function" ? spawnFn : spawn,
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
async function downloadFile({ url, partPath, label, fetchImpl, signal, say, step }) {
  const result = await withRetry(() => attemptDownload({ url, partPath, label, fetchImpl, signal, say, step }), {
    label,
    say,
    signal,
  }).catch((e) => {
    if (isCancelled(e)) throw e;
    throw new Error(label + "没下来：" + redact(e?.message || String(e)) + "。检查一下网络再重新点一次一键安装");
  });
  return result;
}

async function attemptDownload({ url, partPath, label, fetchImpl, signal, say, step }) {
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
  // 416：上次其实已经下满了，只是没来得及改名。有半截文件就直接当它下完。
  if (status === 416) {
    if (offset > 0) return { bytes: offset };
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

  const reader = res?.body?.getReader?.();
  if (!reader) throw new Error("服务器没有返回文件内容");

  await fs.mkdir(path.dirname(partPath), { recursive: true });
  const fh = await fs.open(partPath, start > 0 ? "a" : "w");
  let done = start;
  // 每跨过 10% 才写一行日志，别一个数据块写一行。
  let bucketLogged = total > 0 ? Math.floor((start / total) * 10) : Math.floor(start / (32 * MB));
  try {
    for (;;) {
      if (signal?.aborted) throw cancelledError();
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (!value || !value.length) continue;
      await fh.write(value);
      done += value.length;
      noteProgress(step, done, total);
      const bucket = total > 0 ? Math.floor((done / total) * 10) : Math.floor(done / (32 * MB));
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
  return { bytes: done };
}

/**
 * 跑 exe --version 看看它能不能用，返回 { status, text }。
 *
 * 环境变量必须显式把 TEMP 与 TMP 指到插件自己的 tmp：这台机器上系统临时目录对子进程
 * 不可写，不设就会报 [PYI-2060:ERROR] Could not create temporary directory 直接失败。
 */
function runVersion(exe, { tmpDir, spawnFn, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let child = null;
    let out = "";
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };
    try {
      child = (typeof spawnFn === "function" ? spawnFn : spawn)(exe, ["--version"], {
        windowsHide: true,
        env: { ...process.env, TEMP: tmpDir, TMP: tmpDir },
      });
    } catch (e) {
      reject(e);
      return;
    }
    timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        /* 已经退出了 */
      }
      finish(reject, new Error("下载器复查超过 " + Math.round(timeoutMs / 1000) + " 秒还没回话"));
    }, timeoutMs);
    const take = (d) => {
      out += String(d);
      if (out.length > 4000) out = out.slice(-4000);
    };
    child?.stdout?.on?.("data", take);
    child?.stderr?.on?.("data", take);
    child?.on?.("error", (e) => finish(reject, e));
    child?.on?.("close", (status) => finish(resolve, { status, text: out }));
  });
}

/** 从 --version 的输出里挑出版本号；挑不到返回空串。 */
function pickVersion(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const hit = VERSION_RE.exec(line.trim());
    if (hit) return hit[0];
  }
  return "";
}

async function runSetup(taskId, cfg, { fetchImpl, home, token, signal, spawnFn }) {
  const paths = ytdlpEnvPaths(cfg, { home });
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
    // 第一步：把下载器本体下回来（先镜像、再官方）
    await runStep("download", async (s) => {
      if (sizeOnDisk(paths.exe) >= MIN_BYTES) return "skipped";
      const partPath = paths.exe + ".part";
      const targets = [
        { url: MIRROR_URL, label: "国内镜像" },
        { url: OFFICIAL_URL, label: "官方地址" },
      ];
      let lastErr = null;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        say("从" + t.label + "下载下载器（yt-dlp），支持断点续传");
        try {
          await downloadFile({ url: t.url, partPath, label: "下载器", fetchImpl, signal, say, step: s });
          lastErr = null;
          break;
        } catch (e) {
          if (isCancelled(e) || token.cancelled) throw e;
          lastErr = e;
          if (i + 1 < targets.length) say(t.label + "没成功，改从" + targets[i + 1].label + "下载");
        }
      }
      if (lastErr) throw lastErr;

      const size = sizeOnDisk(partPath);
      if (size < MIN_BYTES) {
        throw new Error("下完只有 " + mbText(size) + " 兆，没到 5 兆，点一键安装重新下一次");
      }
      await fs.mkdir(paths.bin, { recursive: true });
      await fs.rm(paths.exe, { force: true });
      await fs.rename(partPath, paths.exe);
      s.detail = "下好了，共 " + mbText(size) + " 兆";
      say("下载器下好了，共 " + mbText(size) + " 兆");
    });

    // 第二步：跑一下 exe --version 复查
    await runStep("verify", async (s) => {
      await fs.mkdir(paths.tmp, { recursive: true });
      const r = await runVersion(paths.exe, { tmpDir: paths.tmp, spawnFn });
      const version = pickVersion(r.text);
      if (!version) {
        const said = redact(String(r.text || "").trim()).slice(-120);
        throw new Error("下载器跑不起来，点一键安装重下" + (said ? "（它说：" + said + "）" : ""));
      }
      await fs.mkdir(paths.root, { recursive: true });
      await fs.writeFile(path.join(paths.root, "version.txt"), version + "\n", "utf8");
      s.detail = "能跑，版本 " + version;
      say("下载器能跑，版本 " + version);
    });

    state.running = false;
    state.ok = true;
    state.currentStep = null;
    state.finishedAt = Date.now();
    say("下载器装好了，可以用了");
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
