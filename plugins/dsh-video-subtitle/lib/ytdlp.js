/**
 * 只管「跑下载器」，不判断该不该用它。
 *
 * 这一层把借来的那个下载器（yt-dlp）当成一个普通子进程来用：取视频清单、下字幕、
 * 下音轨。站点规则、装没装、要不要用，都不归它管，那是 providers/ytdlp.js 的事。
 *
 * 三条硬规矩：
 *   1) 命令一律用参数数组，绝不拼字符串、绝不走 shell，链接原样传进去。
 *   2) 子进程一律 windowsHide，环境变量把 TEMP 与 TMP 指到插件自己的 tmp 目录：
 *      这台机器上系统临时目录对子进程不可写，不设就会报 [PYI-2060] 直接失败。
 *   3) 取消（signal.abort）与超时都要把子进程杀掉，绝不留下一个孤儿进程。
 *
 * 报错一律翻成四种错误码（UNSUPPORTED_SITE / NO_SUBTITLE / NETWORK，其中「要登录才给看」
 * 也归 UNSUPPORTED_SITE：对用户来说都是这条网址这里取不到），认不出就按 NETWORK 兜底，
 * detail 里带下载器原文（先脱敏）。
 *
 * 测试时可以在 cfg 里塞一个 ytdlpSpawnFn 替换真子进程，导出函数的签名不变。
 */
import { spawn } from "node:child_process";
import { promises as fs, statSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ytdlpEnvPaths } from "./ytdlp-env.js";
import { localEnvPaths } from "./local-env.js";

/** 子进程输出只留尾部这么多字，多了没意义还占内存。 */
const TAIL = 4000;
/** 默认超时：取清单 90 秒，下整条音轨至少 5 分钟。 */
const PROBE_TIMEOUT_MS = 90000;
const AUDIO_TIMEOUT_MS = 300000;

/** 下载器要给哪个程序用；配置里填了就用它，没填就用插件自己装的那份。 */
export function ytdlpExe(cfg = {}) {
  const configured = String(cfg?.ytdlpPath || "").trim();
  return configured || ytdlpEnvPaths(cfg).exe;
}

/**
 * 找一个真正的 node.exe 绝对路径，给下载器的 --js-runtimes 用。
 * 优先用当前进程自己的可执行文件（它是 node 就直接用）；不是的话扫 PATH。
 * 找不到返回 null。路径里可能带空格，调用时按数组传，绝不截断也不加引号。
 */
export function nodeExe() {
  const own = String(process.execPath || "").trim();
  if (own && /^node(\.exe)?$/i.test(path.basename(own))) return own;
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of ["node.exe", "node"]) {
      const full = path.join(dir, name);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* 这个目录里没有，接着找 */
      }
    }
  }
  return null;
}

/** 把话里的用户名、用户目录、带查询串的地址抹掉。日志和报错一律先过这一道。 */
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

/** 下载器原文的最后一段，用在 detail 里。 */
function tailOf(text) {
  const s = redact(text).trim();
  return s.length > 200 ? s.slice(-200) : s;
}

/** 认不出、解析不了：站点不支持，或者清单压根没给出可用的格式。 */
const UNSUPPORTED_PATTERNS = [
  /Unsupported URL/i,
  /no video formats/i,
  /is not a valid URL/i,
  /Unable to extract/i,
  /No video ?formats found/i,
  /Unsupported site/i,
  // 404 = 这个网址根本不是一个视频页，归到「网址不认识」，
  // 别报成网络故障，否则人会一直重试一条永远也不会成功的链接。
  // 注意只认 404：同样是「打不开网页」，5xx 和域名解析失败都是网络问题，不能算网址不对。
  /HTTP Error 404/i,
];

/**
 * 要登录才给看：这类站归到「网址不支持」那一条码里（错误码只有四类），
 * 但 detail 必须写明是「要登录」，绝不替用户登录，也绝不假装取到了。
 */
const LOGIN_PATTERNS = [
  /Sign in to confirm/i,
  /requires authentication/i,
  /Private video/i,
  /members-only/i,
  /This video is unavailable/i,
  /confirm you'?re not a bot/i,
  /Join this channel/i,
  /login required/i,
];

/** 没有字幕：站上现成字幕一条都没有，或者要的语种没下下来。 */
const NO_SUBTITLE_PATTERNS = [
  /There are no subtitles/i,
  /no subtitles/i,
  /No subtitle/i,
  /has no subtitles/i,
  /requested subtitles/i,
  /Unable to download video subtitles/i,
  /no closed captions/i,
];

/**
 * 下载器自己起不来：这台机器上真的发生过，临时目录写不进去，它打一行 PYI 报错就退出。
 * 这不是网络问题、也不是网址问题，得单独说清，否则人会一直重试一条其实没问题的网。
 */
const SELF_PATTERNS = [
  /Could not create temporary directory/i,
  /PYI-\d+:ERROR/i,
  /Failed to execute script/i,
  /No such file or directory.*yt-dlp/i,
];

/** 网络问题：连不上、超时、域名解析失败、服务端出错。 */
const NETWORK_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /getaddrinfo/i,
  /Connection refused/i,
  /Connection reset/i,
  /Unable to connect/i,
  /Temporary failure in name resolution/i,
  /HTTP Error 5\d\d/i,
  /network is unreachable/i,
  /EOF occurred/i,
];

/**
 * 把下载器报错翻成错误码，返回 { code, detail }。
 * code 只有四种；认不出的一律按 NETWORK 兜底，detail 里带原文最后 200 字（先脱敏）。
 */
export function classifyError(text) {
  const raw = String(text ?? "");
  const detail = tailOf(raw);
  const pick = (patterns, code) => (patterns.some((re) => re.test(raw)) ? { code, detail } : null);
  const hit =
    pick(SELF_PATTERNS, "UNSUPPORTED") ??
    pick(UNSUPPORTED_PATTERNS, "UNSUPPORTED_SITE") ??
    pick(NO_SUBTITLE_PATTERNS, "NO_SUBTITLE") ??
    pick(LOGIN_PATTERNS, "UNSUPPORTED_SITE") ??
    pick(NETWORK_PATTERNS, "NETWORK");
  if (!hit) return { code: "NETWORK", detail: "连不上这个站。" + detail };
  // 下载器自己起不来：说清是它的问题，并给出能动手的一步
  if (hit.code === "UNSUPPORTED" && SELF_PATTERNS.some((re) => re.test(raw))) {
    return {
      code: "UNSUPPORTED",
      detail: "下载器没能启动，不是网址的问题。到「设置 → 视频字幕」页的「B站 以外的站用的下载器」那张卡片上，先点「取消安装」再点「重新检查」；还是不行就点「一键安装」重装一次。下载器原话：" + detail,
    };
  }
  // 要登录才给看：错误码只有四类，归到「网址不支持」，但话要说清是「要登录」
  if (hit.code === "UNSUPPORTED_SITE" && LOGIN_PATTERNS.some((re) => re.test(raw)) && !UNSUPPORTED_PATTERNS.some((re) => re.test(raw))) {
    return { code: "UNSUPPORTED_SITE", detail: "这个站要登录才给看，这里不替你登录。下载器原话：" + detail };
  }
  // 每一种都用一句中文开头，后面跟下载器原话：人先看懂发生了什么，再看原话核对
  const LEAD = {
    UNSUPPORTED_SITE: "这个网址下载器认不出是哪个站的视频：",
    NO_SUBTITLE: "站上没有这条字幕：",
    NETWORK: "连不上这个站：",
  };
  return { code: hit.code, detail: (LEAD[hit.code] ?? "") + hit.detail };
}

/** 造一个带 code 与 detail 的错误；pipeline 认这两个字段。 */
function codedError(code, detail) {
  const e = new Error(detail || code);
  e.code = code;
  e.detail = detail || code;
  return e;
}

/** 子进程由谁来起：平时用真的 spawn，测试可以在 cfg 里换掉。 */
function spawnOf(cfg) {
  const fn = cfg?.ytdlpSpawnFn;
  return typeof fn === "function" ? fn : spawn;
}

/**
 * 跑一个子进程，收 stdout/stderr。
 * timeoutMs 到点或 signal.abort 都会把子进程杀掉并抛错。
 */
function runExe(exe, args, { signal, timeoutMs, spawnFn, env, stdoutLimit = TAIL } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(codedError("NETWORK", "已取消"));
      return;
    }
    let child;
    try {
      child = (typeof spawnFn === "function" ? spawnFn : spawn)(exe, args, {
        windowsHide: true,
        env: env ?? process.env,
      });
    } catch (e) {
      reject(codedError("NETWORK", "下载器起不来：" + redact(e?.message || String(e))));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(v);
    };
    const kill = () => {
      try {
        child?.kill?.();
      } catch {
        /* 已经退出了 */
      }
    };
    const onAbort = () => {
      kill();
      finish(reject, codedError("NETWORK", "已取消"));
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        kill();
        finish(reject, codedError("NETWORK", "下载器超过 " + Math.round(timeoutMs / 1000) + " 秒没回话，已经停下"));
      }, timeoutMs);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child?.stdout?.on?.("data", (d) => {
      stdout += String(d);
      // 取清单时整份 JSON 要留着才能解析，只有报错用的那几路才截尾巴
      if (stdout.length > stdoutLimit) stdout = stdout.slice(-stdoutLimit);
    });
    child?.stderr?.on?.("data", (d) => {
      stderr += String(d);
      if (stderr.length > TAIL) stderr = stderr.slice(-TAIL);
    });
    child?.on?.("error", (e) => finish(reject, codedError("NETWORK", "下载器起不来：" + redact(e?.message || String(e)))));
    child?.on?.("close", (status) => finish(resolve, { status, stdout, stderr }));
  });
}

/** 子进程的公共环境：TEMP 与 TMP 必须指到插件自己的 tmp，并且先建好。 */
async function exeEnv(cfg = {}) {
  const tmpDir = ytdlpEnvPaths(cfg).tmp;
  await fs.mkdir(tmpDir, { recursive: true });
  return { ...process.env, TEMP: tmpDir, TMP: tmpDir };
}

/** 下载器本体与公共参数：不带播放列表、不带无关警告。 */
function baseArgs(cfg = {}) {
  const args = ["--no-playlist", "--no-warnings"];
  const node = nodeExe();
  // 下载器要跑 JavaScript 才能解开站上的签名，给它一个明确的 node 路径，别让它自己瞎找
  if (node) args.push("--js-runtimes", "node:" + node);
  return args;
}

/** ffmpeg 在哪：配置里指了就用配置的，否则用插件自己装的那份；不存在就不加这个参数。 */
function ffmpegPathOf(cfg = {}) {
  const file = localEnvPaths(cfg).ffmpeg;
  try {
    return statSync(file).isFile() ? file : "";
  } catch {
    return "";
  }
}

/** 把失败翻译成带错误码的异常；下游只认 code 与 detail。 */
function throwClassified(result, extra = "") {
  const text = [result?.stderr, result?.stdout, extra].filter(Boolean).join("\n");
  const { code, detail } = classifyError(text);
  throw codedError(code, detail || "下载器没成功，也没给出原因");
}

/**
 * 把下载器给的 {语种: [轨道...]} 变成统一的轨列表。
 * formats 取该语种每一条的 ext，去重。auto 表示是站上自动生成的。
 */
function toLangList(map, auto) {
  if (!map || typeof map !== "object") return [];
  const out = [];
  for (const [lang, list] of Object.entries(map)) {
    if (!Array.isArray(list) || !list.length) continue;
    const formats = [...new Set(list.map((x) => String(x?.ext ?? "")).filter(Boolean))];
    // 站上给的语种名有时是「英语 (自动生成)」「中文（人工）」这种，统一抹掉尾巴上的括号备注
    const name = String(list[0]?.name ?? "").replace(/[\s]*[(（][^()（）]*[)）]\s*$/, "").trim() || lang;
    out.push({ lang, name, auto, formats });
  }
  return out;
}

/**
 * 取视频清单（不下载）：标题、时长、语种、现成字幕有哪几条。
 *
 * 成功返回 { ok:true, id, title, durationS, language, extractor, subtitles, automaticCaptions }。
 * 失败抛错，错误对象上带 code 与 detail，绝不自己编一句「没有字幕」。
 */
export async function probe({ url, cfg = {}, signal, timeoutMs } = {}) {
  const exe = ytdlpExe(cfg);
  const args = ["--dump-single-json", "--skip-download", ...baseArgs(cfg), "--", String(url ?? "")];
  const env = await exeEnv(cfg);
  const limit = Number(timeoutMs ?? cfg.timeoutMs ?? PROBE_TIMEOUT_MS) || PROBE_TIMEOUT_MS;
  // --dump-single-json 吐出来的整份清单有几兆（简介、格式、字幕全在里面），
  // 不能按报错用的 4000 字截断，否则 JSON 一定解析失败、还错报成网络问题
  const r = await runExe(exe, args, { signal, timeoutMs: limit, env, spawnFn: spawnOf(cfg), stdoutLimit: 64 * 1024 * 1024 });
  if (r.status !== 0) throwClassified(r);

  let info = null;
  try {
    info = JSON.parse(String(r.stdout || "").trim());
  } catch {
    // 没给出清单：多半是站点不支持，按它原文分类
    throwClassified(r, "拿不到视频清单");
  }
  return {
    ok: true,
    id: String(info?.id ?? ""),
    title: String(info?.title ?? ""),
    durationS: Number(info?.duration ?? 0) || 0,
    language: String(info?.language ?? ""),
    extractor: String(info?.extractor_key ?? info?.extractor ?? ""),
    subtitles: toLangList(info?.subtitles, false),
    automaticCaptions: toLangList(info?.automatic_captions, true),
  };
}

/** 在 dir 里找刚下出来的字幕文件：先按 <id>.<lang>*.srt，再退到任意新出现的 .srt。 */
function pickSrt(dir, id, lang, before) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  const srts = names.filter((n) => /\.srt$/i.test(n));
  const strict = srts.filter((n) => {
    const low = n.toLowerCase();
    const idOk = !id || low.startsWith(String(id).toLowerCase() + ".");
    const langOk = !lang || low.includes(String(lang).toLowerCase());
    return idOk && langOk;
  });
  const fresh = (list) =>
    list
      .map((n) => {
        const full = path.join(dir, n);
        try {
          return { full, at: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((x) => before == null || x.at >= before)
      .sort((a, b) => b.at - a.at);
  const hit = fresh(strict)[0] ?? fresh(srts)[0];
  return hit?.full ?? "";
}

/** 从下载器输出里挑视频 id（形如 [youtube] abc123: Downloading...）；挑不到返回空串。 */
function pickId(stdout) {
  const m = /\[[^\]]+\]\s+([A-Za-z0-9_-]{6,})[:：]/.exec(String(stdout ?? ""));
  return m ? m[1] : "";
}

/**
 * 下一条指定语种的字幕并转成 srt，返回 { path, format:"srt" }。
 * 下载器那边直接要 srt，所以不用再拿 ffmpeg 转一遍；有 ffmpeg 就告诉它放哪，
 * 免得它自己找不着。
 */
export async function downloadSubtitle({ url, lang, auto = false, dir, cfg = {}, signal, timeoutMs } = {}) {
  const exe = ytdlpExe(cfg);
  const outDir = path.resolve(String(dir ?? "."));
  await fs.mkdir(outDir, { recursive: true });
  const before = Date.now() - 1000;

  const args = [
    auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    String(lang ?? ""),
    "--sub-format",
    "srt",
    "--convert-subs",
    "srt",
    "-o",
    path.join(outDir, "%(id)s.%(ext)s"),
    ...baseArgs(cfg),
  ];
  const ffmpeg = ffmpegPathOf(cfg);
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
  args.push("--", String(url ?? ""));

  const env = await exeEnv(cfg);
  const limit = Number(timeoutMs ?? cfg.timeoutMs ?? PROBE_TIMEOUT_MS) || PROBE_TIMEOUT_MS;
  const r = await runExe(exe, args, { signal, timeoutMs: limit, env, spawnFn: spawnOf(cfg) });
  if (r.status !== 0) throwClassified(r);

  const id = pickId(r.stdout);
  const file = pickSrt(outDir, id, lang, before);
  if (!file) {
    const { detail } = classifyError([r.stderr, r.stdout].join("\n"));
    throw codedError("NO_SUBTITLE", detail || "下载器跑完了，但没有下出字幕文件（站上可能没有这个语种的字幕）");
  }
  return { path: file, format: "srt" };
}

/**
 * 下最好的音轨到 dir，返回 { path, host }。
 * host 是链接的主机名（只用于说明从哪个站取的，拿不到就给空串）。
 */
export async function downloadAudio({ url, dir, cfg = {}, signal, timeoutMs } = {}) {
  const exe = ytdlpExe(cfg);
  const outDir = path.resolve(String(dir ?? "."));
  await fs.mkdir(outDir, { recursive: true });
  const before = Date.now() - 1000;

  const args = ["-f", "bestaudio/best", "-o", path.join(outDir, "%(id)s.%(ext)s"), ...baseArgs(cfg)];
  const ffmpeg = ffmpegPathOf(cfg);
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
  args.push("--", String(url ?? ""));

  const env = await exeEnv(cfg);
  const limit = Number(timeoutMs ?? Math.max(AUDIO_TIMEOUT_MS, Number(cfg.timeoutMs ?? 0))) || AUDIO_TIMEOUT_MS;
  const r = await runExe(exe, args, { signal, timeoutMs: limit, env, spawnFn: spawnOf(cfg) });
  if (r.status !== 0) throwClassified(r);

  const id = pickId(r.stdout);
  let names = [];
  try {
    names = readdirSync(outDir);
  } catch {
    names = [];
  }
  const found = names
    .filter((n) => !/\.(srt|vtt|ass|json|part)$/i.test(n))
    .map((n) => {
      const full = path.join(outDir, n);
      try {
        const st = statSync(full);
        return st.isFile() ? { full, at: st.mtimeMs, named: Boolean(id) && n.includes(id) } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.named) - Number(a.named) || b.at - a.at);
  const fresh = found.filter((x) => before == null || x.at >= before);
  const hit = (fresh[0] ?? found[0])?.full ?? "";
  if (!hit) throwClassified(r, "下载器跑完了，但没有下出音频文件");
  let host = "";
  try {
    host = new URL(String(url ?? "")).host;
  } catch {
    host = "";
  }
  return { path: hit, host };
}
