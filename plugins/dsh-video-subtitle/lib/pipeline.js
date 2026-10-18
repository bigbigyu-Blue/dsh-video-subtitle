/**
 * Provider chain, caching, file writing and on-demand reading.
 *
 * Failure semantics: providers are tried in order; a provider that cannot
 * produce a non-empty transcript is recorded in `attempts` and the chain moves
 * on. When every provider fails the caller gets ok:false plus every reason —
 * nothing is ever fabricated to fill the gap.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseVideoInput, resolveShortLink, resolveBilibiliMeta } from "./ids.js";
import { readSlice, srtStats, langSlug, langMatches, detectScriptLang, timelineIssues } from "./srt.js";
import * as nativeProvider from "./providers/native.js";
import * as feiyudoProvider from "./providers/feiyudo.js";
import * as bcutProvider from "./providers/bcut.js";
import * as localProvider from "./providers/local.js";
import { probeLanguage } from "./providers/local.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const PROVIDERS = {
  native: nativeProvider,
  feiyudo: feiyudoProvider,
  bcut: bcutProvider,
  local: localProvider,
};

export class ProviderError extends Error {
  constructor(provider, reason, detail) {
    super(`[${provider}] ${reason}${detail ? `: ${detail}` : ""}`);
    this.provider = provider;
    this.reason = reason;
    this.detail = detail ?? "";
  }
}

const lastAttempts = new Map();


function recordAttempt(provider, result, detail) {
  lastAttempts.set(provider, { result, detail, at: new Date().toISOString() });
}

export function defaultSaveDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "subtitles");
}

/**
 * 会话工作区目录。`workspaceRoot` 由调用方从工具执行上下文取
 * (`exec.agent.session.header.cwd`)，即"发起这次调用的那个会话的工作区"。
 * 每次调用都重新解析，因此新建的会话/新建的工作区照样生效，不是固定路径。
 * 取不到会话工作区时返回空串，调用方退回 defaultSaveDir()。
 */
export function workspaceSaveDir(workspaceRoot, subdir = ".subtitles") {
  const root = String(workspaceRoot ?? "").trim();
  if (!root) return "";
  return path.join(root, String(subdir ?? "").trim() || ".subtitles");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function makeCtx(cfg, signal, log) {
  const ctx = {
    cfg,
    signal,
    log: log ?? (() => {}),
    error: (provider, reason, detail) => new ProviderError(provider, reason, detail),
    sleep: (ms) => sleep(ms, signal),
    async fetchRaw(url, opts = {}) {
      return fetch(url, {
        method: opts.method ?? "GET",
        headers: { "User-Agent": UA, ...(opts.headers ?? {}) },
        body: opts.body,
        signal: opts.signal ?? signal,
        redirect: "follow",
      });
    },
    async request(url, opts = {}) {
      const res = await ctx.fetchRaw(url, opts);
      const json = await res.json().catch(() => null);
      if (json == null) throw new Error(`HTTP ${res.status} 响应不是 JSON: ${url}`);
      return json;
    },
  };
  return ctx;
}

async function runProvider(provider, meta, ctx, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("provider timeout")), timeoutMs);
  const onOuterAbort = () => ac.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener?.("abort", onOuterAbort, { once: true });
  try {
    return await provider.fetchSubtitles({ meta, ctx: { ...ctx, signal: ac.signal, sleep: (ms) => sleep(ms, ac.signal) } });
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener?.("abort", onOuterAbort);
  }
}

function matchesLang(track, want) {
  return langMatches(track?.lang, track?.langDesc, want);
}

function pickTrack(tracks, prefer) {
  for (const want of prefer ?? []) {
    const hit = tracks.find((t) => matchesLang(t, want));
    if (hit) return hit;
  }
  return tracks[0];
}

/**
 * 清掉这个视频已经过期的旧字幕文件。缓存有效期以前只管「还算不算数」，过期文件
 * 从不删除，字幕目录只会越攒越大；现在每次取字幕顺手把本视频的过期件删掉。
 * 只动这一个视频（同一个 bvid 前缀）的文件，不碰别的视频、不碰用户自己放的文件。
 */
async function pruneExpired(outDir, base, cfg) {
  const ttlMs = Number(cfg.cacheTtlDays ?? 30) * 86400000;
  if (!(ttlMs > 0)) return 0;
  let names = [];
  try {
    names = await fs.readdir(outDir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const nm of names) {
    if (!nm.startsWith(`${base}.`)) continue;
    if (!nm.endsWith(".srt") && !nm.endsWith(".meta.json")) continue;
    const full = path.join(outDir, nm);
    const st = await fs.stat(full).catch(() => null);
    if (!st || now - st.mtimeMs <= ttlMs) continue;
    if (await fs.rm(full, { force: true }).then(() => true, () => false)) removed += 1;
  }
  return removed;
}

async function findCache(outDir, base, cfg, lang, durationS) {
  let names = [];
  try {
    names = await fs.readdir(outDir);
  } catch {
    return null;
  }
  const ttlMs = Number(cfg.cacheTtlDays ?? 30) * 86400000;
  const now = Date.now();
  const cands = [];
  for (const nm of names) {
    if (!nm.startsWith(`${base}.`) || !nm.endsWith(".srt")) continue;
    const full = path.join(outDir, nm);
    const st = await fs.stat(full).catch(() => null);
    if (!st) continue;
    if (ttlMs > 0 && now - st.mtimeMs > ttlMs) continue;
    const parts = nm.slice(base.length + 1).replace(/\.srt$/, "").split(".");
    cands.push({ file: full, language: parts[0] ?? "und", source: parts[parts.length - 1] ?? "cache", mtime: st.mtimeMs });
  }
  if (!cands.length) return null;
  const ordered = cands.sort((a, b) => b.mtime - a.mtime);
  for (const want of lang ?? cfg.preferLang ?? []) {
    const hit = ordered.find((c) => matchesLang({ lang: c.language, langDesc: c.language }, want));
    if (hit) {
      ordered.splice(ordered.indexOf(hit), 1);
      ordered.unshift(hit);
      break;
    }
  }
  const fullPct = Number(cfg.fullCoveragePct ?? 90);
  for (const pick of ordered) {
    const content = await fs.readFile(pick.file, "utf8").catch(() => null);
    if (!content) continue;
    const st = srtStats(content);
    if (durationS && st.lastEnd && Math.round((st.lastEnd / durationS) * 100) < fullPct) continue; // 残片不算命中缓存
    if (!timelineIssues(content, durationS).ok) continue; // 时间轴坏掉的旧文件不再当缓存用
    // 命中就算「还在用」：把修改时间刷新一下，免得常用的文件到期被当垃圾清掉
    await fs.utimes(pick.file, new Date(), new Date()).catch(() => {});
    return {
      source: pick.source,
      tracks: [
        {
          lang: pick.language,
          langDesc: pick.language,
          language: pick.language,
          chars: st.textChars,
          blocks: st.blocks,
          firstSec: st.firstStart,
          lastSec: st.lastEnd,
          coveragePct: durationS ? Math.round((st.lastEnd / durationS) * 100) : null,
          path: pick.file,
          picked: true,
        },
      ],
    };
  }
  return null;
}

export async function subtitleFetch(args) {
  // 同一个视频的并发请求共用一次抓取：后到的请求直接等先到的那份结果，
  // 不再各跑一遍完整抓取链、各写一次同一个文件。
  // 共享的那份抓取自己带取消开关：谁取消只结束谁的等待，只有等的人全没了才真的停。
  const { signal, log, ...rest } = args;
  const key = inflightKey(rest);
  let job = inflightFetches.get(key);
  const shared = Boolean(job);
  if (!job) {
    const ac = new AbortController();
    job = { ac, waiters: 0, promise: null };
    job.promise = subtitleFetchInner({ ...rest, signal: ac.signal, log }).finally(() => inflightFetches.delete(key));
    job.promise.catch(() => {}); // 等的人都走了也要把拒绝吞掉，免得报「未处理的错误」
    inflightFetches.set(key, job);
  }
  job.waiters += 1;
  try {
    const value = await abortable(job.promise, signal);
    return shared ? { ...value, shared: true } : value;
  } finally {
    job.waiters -= 1;
    if (job.waiters <= 0) job.ac.abort(new Error("所有请求都已取消"));
  }
}

const inflightFetches = new Map(); // key -> { ac, waiters, promise }

/** 共享的任务不认单个请求者的取消：谁取消就只把谁的等待结束掉。 */
function abortable(job, signal) {
  if (!signal) return job;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    job.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function inflightKey({ url, lang, dir, force = false, cfg = {} }) {
  let id;
  try {
    const p = parseVideoInput(url);
    id = p.short
      ? `short:${String(url).trim().toLowerCase()}`
      : `${p.platform}:${p.bvid ?? p.aid ?? p.videoId ?? ""}:${p.page ?? 1}`;
  } catch {
    id = `raw:${String(url).trim().toLowerCase()}`;
  }
  // force 单独成键：强制重下不能搭上别人「命中缓存」的顺风车，否则强制不生效。
  return `${id}|${lang ?? ""}|${dir ?? ""}|${cfg.saveDir ?? ""}|${force ? "force" : ""}`;
}

/**
 * 工具等待上限：按实际启用的字幕源数量算，再留出取视频信息与落盘的余量。
 * 旧写法固定按 4 个源算死，改了 providerOrder 之后预算不跟着变：源少时白等，
 * 源多时最后一条会被硬掐断。
 */
export function fetchTimeoutBudget(cfg = {}) {
  const per = Math.max(1000, Number(cfg.timeoutMs ?? 90000));
  const count = Math.max(
    1,
    (cfg.providerOrder ?? Object.keys(PROVIDERS)).filter((p) => typeof PROVIDERS[p]?.fetchSubtitles === "function").length,
  );
  return 30000 + per * count + 15000; // 取视频信息 30s + 每个源各一份 + 落盘余量 15s
}

async function subtitleFetchInner({ url, lang, dir, force = false, cfg = {}, signal, log = () => {}, workspaceRoot = "" }) {
  const startedAt = Date.now();
  const parsed0 = parseVideoInput(url);
  const parsed = parsed0.short ? await resolveShortLink(parsed0, { signal }) : parsed0;
  if (parsed.platform !== "bilibili") {
    throw new Error(`目前只支持 bilibili；收到平台 ${parsed.platform}`);
  }

  const ctx = makeCtx(cfg, signal, log);
  const meta = await resolveBilibiliMeta(parsed, { signal, request: (u, o) => ctx.request(u, o) });
  meta.raw = parsed.raw;

  // 落盘顺序：显式 dir 参数 → 配置 saveDir → 当前会话工作区\<workspaceSubdir> → 旧的 DSH_HOME 兜底
  const wsDir = cfg.saveToWorkspace === false ? "" : workspaceSaveDir(workspaceRoot, cfg.workspaceSubdir);
  const outDir = dir
    ? path.resolve(dir)
    : cfg.saveDir
      ? path.resolve(cfg.saveDir)
      : wsDir
        ? path.resolve(wsDir)
        : defaultSaveDir();
  const dirSource = dir ? "arg" : cfg.saveDir ? "config" : wsDir ? "workspace" : "fallback";
  await fs.mkdir(outDir, { recursive: true });
  const base = meta.page > 1 ? `${meta.bvid}-p${meta.page}` : meta.bvid;

  const head = {
    platform: "bilibili",
    bvid: meta.bvid,
    page: meta.page,
    title: meta.title,
    durationS: meta.durationS,
    dir: outDir,
    dirSource,
  };

  if (!force) {
    // 顺手把本视频过期的旧件清掉，字幕目录不会只增不减
    const pruned = await pruneExpired(outDir, base, cfg);
    if (pruned > 0) log(`[videosub] ${base} 清掉 ${pruned} 个过期旧文件`);
    const hit = await findCache(outDir, base, cfg, lang, meta.durationS);
    if (hit) {
      // 命中也要记一笔：这份字幕当年是哪个源给的，排障时一眼能看到，不是空数组
      const detail = `命中本地已有文件（${hit.source}），未发任何请求`;
      recordAttempt(hit.source, "CACHED", detail);
      return {
        ok: true,
        cached: true,
        source: hit.source,
        tracks: hit.tracks,
        attempts: [{ provider: hit.source, result: "CACHED", detail, ms: 0 }],
        elapsedMs: Date.now() - startedAt,
        ...head,
      };
    }
  }

  const order = (cfg.providerOrder ?? []).filter((p) => typeof PROVIDERS[p]?.fetchSubtitles === "function");
  const attempts = [];
  // 完整度门槛：只有覆盖到视频的这个比例，结果才算「取到字幕」。
  // 低于门槛的残片不写盘、不缓存，结果判为失败并如实写明覆盖了多少，绝不当作可用文稿。
  const fullPct = Number(cfg.fullCoveragePct ?? 90);
  const prefer = lang ? [lang] : cfg.preferLang ?? [];
  let best = null; // { pid, tracks, picked, coverage, note }

  for (const pid of order) {
    const t0 = Date.now();
    try {
      const res = await runProvider(PROVIDERS[pid], meta, ctx, Number(cfg.timeoutMs ?? 90000));
      const tracks = (res?.tracks ?? []).filter((t) => t?.content && String(t.content).trim().length > 0);
      if (!tracks.length) {
        attempts.push({ provider: pid, result: "EMPTY", detail: "provider 返回空字幕", ms: Date.now() - t0 });
        recordAttempt(pid, "EMPTY", "provider 返回空字幕");
        continue;
      }
      // 时间轴不可信的轨直接剔除：第三方站偶尔整条时间轴错位，文字对但按时间读会读到错的地方
      const valid = tracks.filter((t) => timelineIssues(t.content, meta.durationS).ok);
      if (!valid.length) {
        const first = pickTrack(tracks, prefer);
        const tl = timelineIssues(first.content, meta.durationS);
        const detail = `${tl.reason} — ${tl.detail}`;
        attempts.push({ provider: pid, result: "BAD_TIMELINE", detail, ms: Date.now() - t0 });
        recordAttempt(pid, "BAD_TIMELINE", detail);
        log(`[videosub] provider ${pid} 时间轴不可信，丢弃：${detail}`);
        continue;
      }
      if (valid.length < tracks.length) {
        log(`[videosub] provider ${pid} 有 ${tracks.length - valid.length} 条轨时间轴不可信，已剔除`);
      }
      const picked = pickTrack(valid, prefer);
      const st = srtStats(picked.content);
      const coverage = meta.durationS ? Math.round((st.lastEnd / meta.durationS) * 100) : null;
      // 择优：保留完整度最高的一条，谁先出不算数
      const fullAudio = res?.fullAudioProcessed === true;
      if (!best || (coverage ?? 0) > (best.coverage ?? 0)) {
        best = { pid, tracks: valid, picked, coverage, fullAudio, note: res?.note ?? "" };
      }
      if (coverage == null || coverage >= fullPct || fullAudio) {
        log(`[videosub] ${base} via ${pid}: 覆盖 ${coverage ?? "?"}%（达标，收工）`);
        break;
      }
      const detail = `只覆盖 ${coverage}%，未达可用线 ${fullPct}%`;
      attempts.push({ provider: pid, result: "PARTIAL", detail, ms: Date.now() - t0 });
      recordAttempt(pid, "PARTIAL", detail);
      log(`[videosub] provider ${pid} 结果不完整：${detail}；继续试下一条路`);
    } catch (e) {
      const reason = e?.reason ?? "ERROR";
      const detail = e?.detail ?? e?.message ?? String(e);
      attempts.push({ provider: pid, result: reason, detail, ms: Date.now() - t0 });
      recordAttempt(pid, reason, detail);
      log(`[videosub] provider ${pid} 失败: ${reason} ${detail}`);
    }
  }

  if (!best) {
    return { ok: false, cached: false, source: null, tracks: [], attempts, elapsedMs: Date.now() - startedAt, ...head };
  }

  const covered = best.fullAudio === true || best.coverage == null || best.coverage >= fullPct;
  if (!covered) {
    log(`[videosub] ${base} 最优结果不完整（覆盖 ${best.coverage}% < ${fullPct}%），按用户要求不写文件`);
    return { ok: false, cached: false, source: best.pid, partial: true, coveragePct: best.coverage, tracks: [], attempts, elapsedMs: Date.now() - startedAt, ...head };
  }

  // 只保留视频原文语种那一条（用户要求）：语种按标题+简介判断，判断不出就保留首选并明确说明
  const detected = detectScriptLang(`${meta.title ?? ""} ${meta.desc ?? ""}`);
  const slugs = best.tracks.map((t) => langSlug(t.lang, t.langDesc));
  const keepAll = cfg.keepOnlyOriginalLang === false;
  let chosen = 0;
  let langNote = "";
  if (!keepAll) {
    if (best.tracks.length === 1) {
      langNote = detected && detected !== slugs[0]
        ? `标题/简介判断原文为 ${detected}，但该视频只有 ${slugs[0]} 一轨，这份很可能是翻译、不是原声`
        : "";
    } else {
      // 标题/简介已经能判断出原文语种、且轨道里就有这一条时，不必再去解码音频探测：
      // 那要拉起 ffmpeg 加一次识别，白花十几秒。只有判断不出（或判断出的轨不存在）才探测。
      const fromMeta = Boolean(detected && slugs.includes(detected));
      let audioLang = null;
      const probeSec = Number(cfg.localProbeSec ?? 60);
      if (!fromMeta && probeSec > 0) {
        try {
          audioLang = await probeLanguage({ meta, ctx });
        } catch (e) {
          log(`[videosub] 音频语种探测失败：${e?.message ?? e}`);
        }
      }
      const fromAudio = Boolean(audioLang && slugs.includes(audioLang));
      const wanted = fromAudio ? audioLang : fromMeta ? detected : (cfg.preferLang ?? []).find((l) => slugs.includes(l));
      chosen = wanted ? slugs.indexOf(wanted) : 0;
      const others = slugs.filter((s, i) => i !== chosen);
      const othersNote = others.length ? `（另有 ${others.join("/")} 已丢弃）` : "";
      const moreNote = others.length ? `；另有 ${others.join("/")} 未保留` : "";
      const audioNote = audioLang && !fromAudio ? `；音频探测到 ${audioLang} 但该轨不存在` : "";
      if (fromAudio || fromMeta) {
        // 确实确认了原声语种，才写「判断原文语种为 X」
        const by = fromAudio ? `音频语种探测（${audioLang}）` : `标题/简介（${detected}）`;
        langNote = `按${by}判断原文语种为 ${slugs[chosen]}，只保留该轨${othersNote}${audioNote}`;
      } else {
        // 确认不了原声语种：照常保留一条，但必须写明这是翻译，不得声称判断出了原文语种
        langNote = `没有${detected ? ` ${detected} ` : "原声"}语种的字幕轨，保留的 ${slugs[chosen]} 轨是翻译、不是原声${detected ? `（标题/简介判断原文为 ${detected}）` : ""}${moreNote}${audioNote}`;
      }
    }
  }
  const toWrite = keepAll ? best.tracks.slice(0, 3) : [best.tracks[chosen] ?? best.picked];
  const keptLang = slugs[chosen] ?? null;
  const availableLangs = [...new Set(slugs)];

  const written = [];
  const seenLangs = new Set();
  for (const t of toWrite) {
    const slug = langSlug(t.lang, t.langDesc);
    if (seenLangs.has(slug)) continue;
    seenLangs.add(slug);
    const file = path.join(outDir, `${base}.${slug}.${best.pid}.srt`);
    await fs.writeFile(file, String(t.content).trimEnd() + "\n", "utf8");
    const st = srtStats(t.content);
    written.push({
      lang: t.lang,
      langDesc: t.langDesc,
      language: slug,
      chars: st.textChars,
      blocks: st.blocks,
      firstSec: st.firstStart,
      lastSec: st.lastEnd,
      coveragePct: meta.durationS ? Math.round((st.lastEnd / meta.durationS) * 100) : null,
      path: file,
      picked: t === best.picked,
    });
  }
  const metaPath = path.join(outDir, `${base}.meta.json`);
  await fs.writeFile(
    metaPath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), url: parsed.raw, meta, source: best.pid, fullCoveragePct: fullPct, partial: false, note: best.note, keptLang, availableLangs, langNote, tracks: written, attempts }, null, 2),
    "utf8",
  );
  const elapsedMs = Date.now() - startedAt;

  recordAttempt(best.pid, "OK", `覆盖 ${best.coverage ?? "?"}%`);
  log(`[videosub] ${base} via ${best.pid}: 覆盖 ${best.coverage ?? "?"}%`);
  return { ok: true, cached: false, source: best.pid, partial: false, metaPath, tracks: written, keptLang, availableLangs, langNote, attempts, elapsedMs, ...head };
}

export async function subtitleRead({ path: file, from, to, maxChars = 6000 }) {
  const full = path.resolve(String(file));
  const content = await fs.readFile(full, "utf8");
  const slice = readSlice(content, { from, to, maxChars });
  const st = srtStats(content);
  return { path: full, totalBlocks: st.blocks, ...slice };
}

/**
 * 各源的接线状态与最近一次结果。本地转写那条不再写死「缺 AAC 解码、占位返回」这种
 * 过期说法——它其实早就能用了，只是依赖 ffmpeg、sherpa-onnx 原生模块与 SenseVoice 模型，
 * 这里现查本机到底缺哪一样，缺什么就照实说什么。
 */
export function providersStatus(cfg = {}) {
  return Object.keys(PROVIDERS).map((pid) => {
    const a = lastAttempts.get(pid);
    const p = PROVIDERS[pid];
    let placeholder = null;
    let missing = null;
    if (pid === "local" && typeof localProvider.availability === "function") {
      try {
        const av = localProvider.availability(cfg);
        if (!av.ready) {
          missing = av.missing;
          placeholder = `本机缺：${av.missing.join("、")}`;
        }
      } catch (e) {
        placeholder = `可用性检查失败：${e?.message ?? e}`;
      }
    }
    return {
      provider: pid,
      wired: typeof p.fetchSubtitles === "function",
      placeholder,
      missing,
      lastResult: a?.result ?? null,
      lastDetail: a?.detail ?? null,
      lastAt: a?.at ?? null,
    };
  });
}
