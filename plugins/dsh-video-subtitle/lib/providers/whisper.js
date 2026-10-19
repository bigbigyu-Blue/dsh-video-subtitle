/**
 * Provider `whisper` — 本机 faster-whisper 转写，不依赖任何外部服务、没有次数限制。
 *
 * 为什么单独一个源：官方源要登录，且长视频的官方字幕只覆盖开头一小段（实测 40 小时的
 * 视频只给开头几分钟），这时候只能靠本机转写。本机已经装好 faster-whisper（Python 虚拟环境 + small 模型），
 * 音频直接用 PyAV 解码，不需要 ffmpeg，是唯一一个「任何视频都能转、且不会用完」的来源。
 *
 *   dash audio (anonymous playurl) -> .m4s
 *     -> python + faster-whisper (CPU int8) -> 条目 JSON -> SRT
 *
 * 速度：默认走 BatchedInferencePipeline 批处理 + 词级时间戳，再按标点/字数重新切成短条目。
 * 实测 180 秒音频 22.5 秒降到 17.9 秒（1.25 倍）；1494 秒整段 130.9 秒（约 11 倍实时），
 * 30 分钟视频约 2 分半。批处理不可用时自动退回逐段转写，结果仍然可用。
 * 转写进程常驻：模型只加载一次（small 模型实测加载 2.45 秒），连着取视频只有第一条付这笔钱。
 * 超时上限单独按 whisperTimeoutMs 算（默认 30 分钟），不跟别的源共用 90 秒。
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { msToTimestamp } from "../srt.js";
import { asrPaths } from "../asr-env.js";

export const id = "whisper";
const API = "https://api.bilibili.com";

/** 句末标点：词尾遇到这些就把当前条目收掉。 */
const FINAL_PUNCT = "。！？!?…";

/** 常驻进程回话的行前缀，必须与 SCRIPT 里的 PREFIX 一致。 */
const FN = "@@VSUB@@";

/**
 * 词级切分（与 SCRIPT 里的 Python 实现逐字对应，改一处就要改另一处）：
 * 逐词累加，词尾是句末标点或累加字数达到 maxChars 就收一条；
 * start/end 取该条首词 start 与末词 end，并保证时间轴单调、end 大于 start。
 */
export function splitWordsToCues(words, { maxChars = 24 } = {}) {
  const limit = Math.max(4, Math.trunc(Number(maxChars)) || 24);
  const cues = [];
  if (!Array.isArray(words)) return cues;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.map((w) => w.text).join("").trim();
    if (text) cues.push({ start: buf[0].start, end: buf[buf.length - 1].end, text });
    buf = [];
  };
  for (const w of words) {
    const raw = String(w?.word ?? w?.text ?? "");
    const text = raw.trim();
    if (!text) continue;
    buf.push({ start: Number(w.start) || 0, end: Number(w.end) || 0, text: raw });
    const joined = buf.map((b) => b.text).join("").trim();
    if (FINAL_PUNCT.includes(text.slice(-1)) || joined.length >= limit) flush();
  }
  flush();
  return clampCues(cues);
}

/** 收尾兜底：时间轴单调、end 至少比 start 大 0.01 秒。 */
function clampCues(cues) {
  const out = [];
  let prevEnd = 0;
  for (const c of cues) {
    const start = Math.max(c.start, prevEnd);
    const end = Math.max(c.end, start + 0.01);
    const text = String(c.text ?? "").trim();
    if (!text) continue;
    prevEnd = end;
    out.push({ start, end, text });
  }
  return out;
}

/**
 * 内嵌的转写脚本。原来是一次跑一条：参数传进来、转完写 JSON、进程退出。
 * 现在改成常驻：从标准输入一行一行读任务、一行一行回结果，读到输入关闭才退出。
 *
 *   {"audio": 音频路径, "out": 结果文件, "model": 模型名, "threads": 线程数,
 *    "lang": 语种, "batch_size": 批大小, "max_chars": 每条字数上限}
 *
 * 回的行以 @@VSUB@@ 开头，内容是 {"ok":..,"error":..,"wrote":..}；其余行（模型自己的
 * 提示音、警告）一律丢掉。结果照旧写进 out 文件，不塞进标准输出，
 * 所以音频读、结果写的权限要求跟以前一模一样。
 */
const SCRIPT = `
import json, os, sys

# 与 whisper.js 里的 FN 一字不差；改了要一起改
PREFIX = "@@VSUB@@"
FINAL_PUNCT = "。！？!?…"


def say(obj):
    sys.stdout.write(PREFIX + json.dumps(obj, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def split_words(words, max_chars):
    cues = []
    buf = []

    def flush():
        if not buf:
            return
        text = "".join([w[2] for w in buf]).strip()
        if text:
            cues.append([buf[0][0], buf[-1][1], text])
        del buf[:]

    for st, en, wd in words:
        wd = wd or ""
        if not wd.strip():
            continue
        buf.append([float(st), float(en), wd])
        joined = "".join([w[2] for w in buf]).strip()
        if wd.strip()[-1] in FINAL_PUNCT or len(joined) >= max_chars:
            flush()
    flush()
    return cues


def cues_of(segs, max_chars):
    rows = []
    for s in segs:
        words = list(getattr(s, "words", None) or [])
        text = (s.text or "").strip()
        if words:
            rows.extend(split_words([(w.start, w.end, w.word) for w in words], max_chars))
        elif text:
            rows.append([float(s.start), float(s.end), text])
    return rows


def clamp_rows(rows):
    out = []
    prev_end = 0.0
    for st, en, text in rows:
        text = (text or "").strip()
        if not text:
            continue
        st = max(float(st), prev_end)
        en = max(float(en), st + 0.01)
        prev_end = en
        out.append({"start": st, "end": en, "text": text})
    return out


# 同一个进程里只留一套模型：换了模型名或线程数就重新加载，别把两套都留在内存里
_loaded = {}


def get_model(name, threads):
    from faster_whisper import WhisperModel, BatchedInferencePipeline
    key = (name, int(threads))
    hit = _loaded.get(key)
    if hit:
        return hit
    m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=int(threads))
    try:
        bp = BatchedInferencePipeline(model=m)
    except Exception:
        bp = None
    _loaded.clear()
    _loaded[key] = (m, bp)
    return _loaded[key]


def num(v, d):
    try:
        return int(float(v))
    except Exception:
        return d


def transcribe(req):
    res = {"ok": False, "error": "", "language": "", "duration": 0, "segments": [], "mode": "plain", "fallback": ""}
    try:
        audio = req.get("audio") or ""
        if not audio:
            raise ValueError("缺少音频路径")
        model_name = req.get("model") or "small"
        threads = num(req.get("threads"), 4)
        lang = req.get("lang") or "auto"
        batch_size = max(0, num(req.get("batch_size"), 0))
        max_chars = max(4, num(req.get("max_chars"), 24))
        m, bp = get_model(model_name, threads)
        kw = {"vad_filter": True, "beam_size": 1, "log_progress": False}
        # 中文不设提示时 small 模型时常吐繁体；给一句简体提示就能稳定成简体
        if not lang or lang == "auto" or lang.startswith("zh"):
            kw["initial_prompt"] = "以下是普通话的句子，用简体中文。"
        if lang and lang != "auto":
            kw["language"] = lang
        rows = None
        info = None
        if batch_size > 0 and bp is not None:
            try:
                # 注意：faster-whisper 1.2.1 的批处理与 clip_timestamps 不兼容，绝不能传
                segs, info = bp.transcribe(audio, batch_size=int(batch_size), word_timestamps=True, **kw)
                rows = cues_of(segs, max_chars)
                res["mode"] = "batch"
                res["batch_size"] = batch_size
            except Exception as be:
                res["fallback"] = "%s: %s" % (type(be).__name__, be)
                rows = None
        if rows is None:
            segs, info = m.transcribe(audio, **kw)
            rows = []
            for s in segs:
                t = (s.text or "").strip()
                if t:
                    rows.append([float(s.start), float(s.end), t])
            res["mode"] = "plain"
        res["segments"] = clamp_rows(rows)
        res["language"] = getattr(info, "language", "") or ""
        res["duration"] = float(getattr(info, "duration", 0) or 0)
        res["ok"] = True
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    return res


def main():
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            say({"ok": False, "error": "这一行任务读不懂: %s" % e, "wrote": False})
            continue
        res = transcribe(req)
        out = req.get("out") or ""
        wrote = False
        if out:
            try:
                with open(out, "w", encoding="utf-8") as f:
                    json.dump(res, f, ensure_ascii=False)
                wrote = True
            except Exception as e:
                note = "写结果文件失败 %s: %s" % (type(e).__name__, e)
                res["error"] = (res["error"] + "；" if res["error"] else "") + note
        say({"ok": bool(res.get("ok")), "error": res.get("error") or "", "wrote": wrote})


main()
`;

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function resolvePaths(cfg) {
  // 转写环境装在哪一套由 asr-env 统一算：界面上点「一键安装」装到插件自己的位置，
  // 已经装过老环境（bili-duty）的机器直接沿用，不用重装。
  const env = asrPaths(cfg);
  const tmpRoot = cfg.whisperTmpDir || process.env.DSH_WHISPER_TMP || env.tmpRoot;
  return {
    python: cfg.whisperPython || process.env.DSH_WHISPER_PYTHON || env.python,
    hfHome: cfg.whisperHfHome || env.hfHome,
    model: cfg.whisperModel || "small",
    threads: Number(cfg.whisperThreads ?? cfg.localThreads ?? 4),
    // 0 表示关闭批处理，退回逐段转写
    batchSize: Math.max(0, Math.trunc(numOr(cfg.whisperBatchSize, 8))),
    maxChars: Math.max(4, Math.trunc(numOr(cfg.whisperMaxChars, 24))),
    // 系统临时目录在受限环境下不可写（建子目录会被系统拦住），所以临时目录一律放在
    // 实际要跑的那个解释器旁边 —— asr-env 已经算好，这里连同备用位置一起拿过来。
    tmpRoot,
    tmpCandidates: env.tmpCandidates ?? [],
    // 关掉常驻就每条新开一个进程，跑完就收（慢，但能排除常驻本身的问题）
    reuseModel: cfg.whisperReuseModel !== false,
    // 常驻脚本放在临时目录旁边：那个位置解释器与 Node 都写得进去
    script: path.join(tmpRoot, "vsub-asr-server.py"),
  };
}

/** 找一个真能建目录的地方当临时工作区；个个都不行就把试过的地方和最后一个错都写出来。 */
export async function makeTmpDir(root, extra = []) {
  const candidates = [...new Set([root, ...extra, os.tmpdir()].filter(Boolean))];
  let lastErr = null;
  for (const base of candidates) {
    try {
      await fs.mkdir(base, { recursive: true });
      return await fs.mkdtemp(path.join(base, "vsub-"));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    "转写用的临时目录都建不了（" + candidates.join("、") + "）：" + (lastErr?.message ?? lastErr) +
      "。可以在插件配置里把 whisperTmpDir 指到一个能写的目录。",
  );
}

/** 本机到底能不能跑：python 在不在、模型缓存有没有。给 providersStatus 用。 */
export function availability(cfg = {}) {
  const p = resolvePaths(cfg);
  const missing = [];
  if (!existsSync(p.python)) missing.push(`Python 环境（${p.python}）`);
  if (!existsSync(path.join(p.hfHome, "hub"))) missing.push(`模型缓存（${p.hfHome}）`);
  // 临时目录缺了不算缺件：真开转写时会自己建（makeTmpDir），提前说成不可用只会让人白点一键安装
  return { ready: missing.length === 0, missing };
}

/**
 * 常驻转写进程：模型只加载一次，之后每段音频发一行 JSON、收一行结果。
 *
 * 为什么要常驻：模型加载单独就要两秒多（small 模型实测 2.45 秒），每取一条视频都重来一遍，
 * 连着取十条就白等二十几秒。常驻之后只有第一条付这笔钱。
 *
 * 不听话的进程整个扔掉重开：超时、崩溃、Python 换了、模型缓存换了都换新进程，
 * 上一段的错绝不留给下一段。空闲十分钟自动收掉，不白占内存。
 */
export function createDaemon({ spawnFn = spawn, idleMs = 10 * 60 * 1000 } = {}) {
  let child = null;
  let key = "";
  let buf = "";
  let stderr = "";
  let pending = null;
  let idleTimer = null;
  let chain = Promise.resolve();

  function settlePending(ok, value) {
    const p = pending;
    if (!p) return;
    pending = null;
    if (p.timer) clearTimeout(p.timer);
    try {
      p.signal?.removeEventListener?.("abort", p.onAbort);
    } catch {
      /* 取消订阅失败不影响结果 */
    }
    if (ok) p.resolve(value);
    else p.reject(value instanceof Error ? value : new Error(String(value ?? "转写进程停了")));
  }

  function dropChild(why) {
    const c = child;
    child = null;
    key = "";
    buf = "";
    if (c) {
      try {
        c.kill();
      } catch {
        /* 已经退出了 */
      }
    }
    settlePending(false, why);
  }

  // 空闲时不占着调用方的进程：不这样，宿主或脚本会因为还挂着一个转写进程而退不出去
  function unrefAll(c) {
    try {
      c?.unref?.();
      c?.stdin?.unref?.();
      c?.stdout?.unref?.();
      c?.stderr?.unref?.();
    } catch {
      /* 个别平台没有 unref，忽略即可 */
    }
  }

  function refAll(c) {
    try {
      c?.ref?.();
      c?.stdin?.ref?.();
      c?.stdout?.ref?.();
      c?.stderr?.ref?.();
    } catch {
      /* 个别平台没有 ref，忽略即可 */
    }
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    if (!(idleMs > 0)) return;
    idleTimer = setTimeout(() => {
      if (!pending) dropChild(new Error("转写进程空闲太久，已收掉"));
    }, idleMs);
    // 空闲期间只靠这个定时器收它，不挡着宿主退出
    unrefAll(child);
    idleTimer.unref?.();
  }

  function ensureChild(p) {
    const k = p.python + "|" + p.hfHome + "|" + p.script;
    if (child && key === k) return;
    if (child) dropChild(new Error("转写环境换了，换一个转写进程"));
    const c = spawnFn(p.python, [p.script], {
      windowsHide: true,
      env: { ...process.env, HF_HOME: p.hfHome, HF_ENDPOINT: "https://hf-mirror.com", HF_HUB_DISABLE_XET: "1" },
    });
    child = c;
    key = k;
    buf = "";
    stderr = "";
    c.stdout?.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.startsWith(FN)) continue;
        let msg = null;
        try {
          msg = JSON.parse(line.slice(FN.length));
        } catch {
          continue;
        }
        settlePending(true, msg);
      }
    });
    c.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    c.stdin?.on("error", () => {
      /* 进程没了会在 close 里处理，写管道报错不用另外管 */
    });
    c.on?.("error", (e) => {
      if (child === c) dropChild(e);
    });
    c.on?.("close", (status) => {
      if (child !== c) return;
      const tail = stderr.trim().slice(-600);
      dropChild(new Error(`转写进程退出了 status=${status}${tail ? `：${tail}` : ""}`));
    });
  }

  function runNow(p, job, { timeoutMs = 0, signal, keep = true } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("已取消"));
    clearIdle();
    ensureChild(p);
    // 有活在跑，这一刻必须挡住退出，不然转写还没回话进程就没了
    refAll(child);
    const line = JSON.stringify(job) + "\n";
    return new Promise((resolve, reject) => {
      const onAbort = () => dropChild(signal?.reason ?? new Error("已取消"));
      const done = () => {
        clearIdle();
        dropChild(new Error("这条转写按配置不复用进程"));
      };
      // 不复用时：这条一有结果就把进程收掉，下一段重新加载模型
      pending = {
        resolve: keep ? resolve : (v) => { resolve(v); done(); },
        reject: keep ? reject : (v) => { reject(v); done(); },
        signal,
        onAbort,
        timer: timeoutMs
          ? setTimeout(() => dropChild(new Error(`转写超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)
          : null,
      };
      if (keep) {
        const orig = pending.resolve;
        pending.resolve = (v) => {
          orig(v);
          armIdle();
        };
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        child.stdin.write(line);
      } catch (e) {
        dropChild(e);
      }
    });
  }

  return {
    /** 排队跑一段：同一时刻只跑一段，模型只有一套，谁也别插队。 */
    run(p, job, opts = {}) {
      const task = chain.then(() => runNow(p, job, opts));
      chain = task.then(() => {}, () => {});
      return task;
    },
    /** 立刻收掉进程（不再等空闲超时）。 */
    stop() {
      clearIdle();
      if (child) dropChild(new Error("转写进程已停止"));
    },
    /** 当前有没有活着的转写进程，给状态与测试用。 */
    get alive() {
      return Boolean(child);
    },
  };
}

/** 全插件共用一个常驻进程：模型加载一次，之后谁取字幕都用它。 */
export const daemon = createDaemon();

/** 进程退出时顺手把子进程收掉，别留下一个孤儿 Python。 */
try {
  process.once("exit", () => {
    try {
      daemon.stop();
    } catch {
      /* 退出阶段不能再抛错 */
    }
  });
} catch {
  /* 极少数宿主没有 process 事件，那就只靠空闲超时收 */
}

function blocksToSrt(blocks) {
  const lines = [];
  blocks.forEach((b, i) => {
    lines.push(String(i + 1));
    const end = Math.max(b.end, b.start + 0.4);
    lines.push(`${msToTimestamp(b.start * 1000)} --> ${msToTimestamp(end * 1000)}`);
    lines.push(b.text.trim());
    lines.push("");
  });
  return lines.join("\n");
}

export async function fetchSubtitles({ meta, ctx }) {
  const p = resolvePaths(ctx.cfg);
  if (!existsSync(p.python)) {
    throw ctx.error(id, "UNSUPPORTED", `找不到 Python 环境：${p.python}（配置 whisperPython）`);
  }
  if (!existsSync(path.join(p.hfHome, "hub"))) {
    throw ctx.error(id, "UNSUPPORTED", `找不到模型缓存：${p.hfHome}（配置 whisperHfHome）`);
  }

  const maxMin = Number(ctx.cfg.whisperMaxMinutes ?? 180);
  if (meta.durationS && meta.durationS / 60 > maxMin) {
    throw ctx.error(id, "UNSUPPORTED", `视频 ${(meta.durationS / 60).toFixed(0)} 分钟，超过本地转写上限 ${maxMin} 分钟`);
  }

  const headers = { Referer: "https://www.bilibili.com/" };
  const pu = await ctx.request(
    `${API}/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&fnval=16&qn=64&fourk=1`,
    { headers, signal: ctx.signal },
  );
  const audio = pu?.data?.dash?.audio?.[0];
  const audioUrl = audio?.baseUrl ?? audio?.base_url;
  if (!audioUrl) throw ctx.error(id, "AUDIO_UNAVAILABLE", "dash.audio[0] 缺失");

  // 匿名 playurl 对一部分视频只给「试看片段」（实测某 72 分钟视频只给 616 秒音频），
  // dash.duration 会如实写出这个片段长度。不比对就会把「只转了一小段」当成整段转完。
  const dashDur = Number(pu?.data?.dash?.duration ?? 0);
  const fullS = Number(meta.durationS ?? 0);
  if (dashDur > 0 && fullS > 0 && dashDur < fullS * 0.95) {
    throw ctx.error(
      id,
      "AUDIO_TRUNCATED",
      `匿名只有试看片段：音频 ${Math.round(dashDur)} 秒，视频 ${Math.round(fullS)} 秒（要完整音频得登录）`,
    );
  }
  let host = "";
  try {
    host = new URL(audioUrl).host;
  } catch {
    /* ignore */
  }

  const tmp = await makeTmpDir(p.tmpRoot, p.tmpCandidates);
  const m4s = path.join(tmp, "a.m4s");
  const outJson = path.join(tmp, "out.json");
  try {
    const res = await ctx.fetchRaw(audioUrl, { headers, signal: ctx.signal });
    if (!res.ok) throw ctx.error(id, "AUDIO_UNAVAILABLE", `音频下载 HTTP ${res.status}（主机 ${host}）`);
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(m4s);
      Readable.fromWeb(res.body).pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
    // 常驻进程读的是这个脚本文件：每段转写前重写一遍，改完代码立刻生效，不用重启插件
    await fs.writeFile(p.script, SCRIPT, "utf8");

    const langArg = String(ctx.cfg.whisperLang || "auto");
    const timeoutMs = Math.max(60000, Number(ctx.cfg.whisperTimeoutMs ?? 1800000));
    ctx.log(
      `[videosub] whisper 开始转写 ${meta.bvid}（模型 ${p.model}，批处理 ${p.batchSize || "关"}，${p.reuseModel ? "沿用常驻进程" : "每条新开进程"}，上限 ${Math.round(timeoutMs / 60000)} 分钟）`,
    );
    const run = await daemon.run(
      p,
      {
        audio: m4s,
        out: outJson,
        model: p.model,
        threads: p.threads,
        lang: langArg,
        batch_size: p.batchSize,
        max_chars: p.maxChars,
      },
      { timeoutMs, signal: ctx.signal, keep: p.reuseModel },
    );
    if (!existsSync(outJson)) {
      const err = String(run?.error || "");
      if (/PermissionError|Permission denied/i.test(err)) {
        throw ctx.error(
          id,
          "LOCAL_ASR_FAILED",
          `转写跑完了但写不出结果文件，系统不让往 ${tmp} 里写（老环境里的 Python 只能写它自己那棵树）。换个临时目录或者把插件配置里的 whisperTmpDir 指到能写的位置。原始报错：${err.slice(-200)}`,
        );
      }
      throw ctx.error(id, "LOCAL_ASR_FAILED", `转写没有产出结果 ${err.slice(-300)}`);
    }
    const parsed = JSON.parse(await fs.readFile(outJson, "utf8"));
    if (!parsed.ok) throw ctx.error(id, "LOCAL_ASR_FAILED", String(parsed.error || "转写失败").slice(0, 300));
    const segs = (parsed.segments ?? []).filter((s) => s?.text);
    if (!segs.length) throw ctx.error(id, "NO_SUBTITLE", "本地转写没有产出文字（音频里可能没有说话声）");

    const lang = String(parsed.language || "und").toLowerCase();
    const minutes = (Number(parsed.duration || meta.durationS || 0) / 60).toFixed(1);
    const speedNote =
      parsed.mode === "batch"
        ? ` · 批处理加速（每批 ${Number(parsed.batch_size || p.batchSize)} 条）`
        : parsed.fallback
          ? ` · 批处理降级（${String(parsed.fallback).slice(0, 120)}）`
          : "";
    return {
      source: id,
      fullAudioProcessed: true,
      note: `本地 faster-whisper 转写 ${minutes} 分钟音频（模型 ${p.model}）· 音频主机 ${host}${speedNote}`,
      tracks: [
        {
          lang,
          langDesc: `本地 faster-whisper 转写（${lang}）`,
          content: blocksToSrt(segs),
          format: "srt",
        },
      ],
    };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
