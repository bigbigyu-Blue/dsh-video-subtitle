/**
 * Provider `local` — fully self-hosted transcription: no third party, no credentials,
 * no rate limit, and it does not care which CDN Bilibili hands out.
 *
 *   dash audio (anonymous playurl) -> .m4s
 *     -> ffmpeg  -> 16 kHz mono WAV              (static build from python package imageio-ffmpeg)
 *     -> sherpa-onnx + SenseVoice int8 model     (both already present on this machine)
 *     -> SRT
 *
 * Windowing, not VAD: the Node binding's voice-activity API was probed —
 * createVoiceActivityDetector(config, bufferSizeInSeconds) builds fine, but it reported
 * zero speech on audio that is demonstrably speech (RMS 0.17-0.20, token timestamps land
 * on real words). So this provider transcribes fixed windows of `localWindowSec` and splits
 * each window's token stream into blocks by pause length / length cap. Timestamps are
 * window-accurate, not VAD-accurate. Every window is transcribed, so the result is marked
 * `fullAudioProcessed: true` — completeness is guaranteed by construction, not by coverage %.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs, existsSync, readdirSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { msToTimestamp, detectScriptLang } from "../srt.js";

export const id = "local";
const API = "https://api.bilibili.com";
const require = createRequire(import.meta.url);
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

let cached = null; // { key, sherpa, rec, lang }

function findImageioFfmpeg() {
  const roots = [path.join(process.env.LOCALAPPDATA || "", "Programs", "Python")];
  for (const root of roots) {
    let versions = [];
    try {
      versions = readdirSync(root);
    } catch {
      continue;
    }
    for (const v of versions) {
      const dir = path.join(root, v, "Lib", "site-packages", "imageio_ffmpeg", "binaries");
      try {
        const exe = readdirSync(dir).find((n) => /^ffmpeg.*\.exe$/i.test(n));
        if (exe) return path.join(dir, exe);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function findAddon() {
  const rel = path.join("resources", "app.asar.unpacked", "dsh", "node_modules", "sherpa-onnx-win-x64", "sherpa-onnx.node");
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, rel.replace(/^resources[\\/]/, "")));
  const exeDir = path.dirname(process.execPath);
  cands.push(path.join(exeDir, rel), path.join(exeDir, "..", rel));
  // 独立 node 下运行（本地验证）时 execPath 不是 app，改为扫安装目录
  const programs = path.join(process.env.LOCALAPPDATA || "", "Programs");
  try {
    for (const d of readdirSync(programs)) cands.push(path.join(programs, d, rel));
  } catch {
    /* 没有该目录就跳过 */
  }
  return cands.find((c) => existsSync(c)) ?? null;
}

function resolvePaths(cfg) {
  const base = path.join(DSH_HOME, "speech-to-text", "sensevoice", "models", "sensevoice-onnx");
  return {
    ffmpeg: cfg.ffmpegPath || process.env.IMAGEIO_FFMPEG_EXE || findImageioFfmpeg(),
    addon: cfg.sherpaAddonPath || findAddon(),
    model: cfg.senseVoiceModel || path.join(base, "model.int8.onnx"),
    tokens: cfg.senseVoiceTokens || path.join(base, "tokens.txt"),
  };
}

function getRecognizer(p, cfg) {
  const key = `${p.addon}|${p.model}|${p.tokens}|${cfg.localThreads ?? 4}`;
  if (cached?.key === key) return cached;
  const sherpa = require(p.addon);
  const rec = sherpa.createOfflineRecognizer({
    modelConfig: {
      modelType: "sensevoice",
      senseVoice: { model: p.model, language: "auto", useInverseTextNormalization: 1 },
      tokens: p.tokens,
      numThreads: Number(cfg.localThreads ?? 4),
      provider: "cpu",
      debug: 0,
    },
  });
  cached = { key, sherpa, rec, lang: "und" };
  return cached;
}

function pushBlocks(out, result, windowStart, windowLen) {
  const text = String(result?.text ?? "");
  if (!text.trim()) return;
  const tokens = (result?.tokens ?? []).filter((t) => !/^<\|.*\|>$/.test(t));
  const stamps = result?.timestamps ?? [];
  if (!tokens.length || tokens.length !== stamps.length) {
    out.push({ start: windowStart, end: windowStart + windowLen, text });
    return;
  }
  let cur = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const at = windowStart + Number(stamps[i] || 0);
    if (!cur || at - cur.end >= 0.6 || cur.text.length + tok.length > 24) {
      if (cur && cur.text.trim()) out.push(cur);
      cur = { start: at, end: at, text: tok };
    } else {
      cur.text += tok;
      cur.end = at;
    }
  }
  if (cur && cur.text.trim()) {
    cur.end = Math.max(cur.end, windowStart + windowLen * 0.999);
    out.push(cur);
  }
}

function blocksToSrt(blocks) {
  const lines = [];
  blocks.forEach((b, i) => {
    lines.push(String(i + 1));
    lines.push(`${msToTimestamp(b.start * 1000)} --> ${msToTimestamp(Math.max(b.end, b.start + 0.4) * 1000)}`);
    lines.push(b.text.trim());
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * 异步跑一个子进程，等它退出。超时与取消都会把子进程杀掉，绝不阻塞事件循环。
 * 返回 { status, stderr }，与原来的同步写法保持同样的调用方式。
 */
export function runProcess(exe, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(v);
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    };
    const onAbort = () => {
      kill();
      finish(reject, new Error("已取消"));
    };
    const timer = timeoutMs ? setTimeout(() => {
      kill();
      finish(reject, new Error(`子进程超时（${Math.round(timeoutMs / 1000)} 秒）：${path.basename(exe)}`));
    }, timeoutMs) : null;
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.stderr?.on("data", (d) => {
      stderr += d;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (status) => finish(resolve, { status, stderr }));
  });
}

/**
 * 自己解析 16 位 PCM 的 WAV，不用 sherpa 的 readWave：
 * readWave 返回的是「外部内存」数组，Electron 主进程直接抛
 * `External buffers are not allowed`（本机实测，插件里必崩）。
 * 自己读成普通 Float32Array 再交给识别器，绕开这个限制。
 */
async function readWavPcm16(file) {
  const buf = await fs.readFile(file);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是 WAV 文件");
  }
  let off = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataStart = body;
      dataLen = size;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error("WAV 缺少 fmt/data 块");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`只支持 16 位 PCM：format=${fmt.format} bits=${fmt.bits}`);
  if (fmt.channels !== 1) throw new Error(`只支持单声道：channels=${fmt.channels}`);
  const count = Math.floor(Math.min(dataLen, buf.length - dataStart) / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  return { sampleRate: fmt.sampleRate, samples };
}

/**
 * 只取前 `localProbeSec` 秒音频，判断音频里的语言。用于多语言字幕轨时确定"原文语种"——
 * 标题是中文但音频是外语时，只按标题会选中翻译轨。
 * 直接让 ffmpeg 读远程 URL，不落整段音频。判断不出（或本地件缺失）返回 null。
 */
export async function probeLanguage({ meta, ctx }) {
  const p = resolvePaths(ctx.cfg);
  if (!p.ffmpeg || !p.addon || !existsSync(p.model)) return null;
  const headers = { Referer: "https://www.bilibili.com/" };
  const pu = await ctx.request(
    `${API}/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&fnval=16&qn=64&fourk=1`,
    { headers, signal: ctx.signal },
  );
  const url = pu?.data?.dash?.audio?.[0]?.baseUrl ?? pu?.data?.dash?.audio?.[0]?.base_url;
  if (!url) return null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "videosub-probe-"));
  const wav = path.join(tmp, "p.wav");
  try {
    const dec = await runProcess(
      p.ffmpeg,
      ["-y", "-hide_banner", "-loglevel", "error", "-headers", "Referer: https://www.bilibili.com/\r\n", "-i", url, "-t", String(Number(ctx.cfg.localProbeSec ?? 60)), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
      { timeoutMs: 180000, signal: ctx.signal },
    );
    if (dec.status !== 0 || !existsSync(wav)) return null;
    const { sherpa, rec } = getRecognizer(p, ctx.cfg);
    const w = await readWavPcm16(wav);
    if (!w.samples.length) return null;
    const stream = sherpa.createOfflineStream(rec);
    sherpa.acceptWaveformOffline(stream, { samples: w.samples, sampleRate: w.sampleRate || 16000 });
    sherpa.decodeOfflineStream(rec, stream);
    const j = JSON.parse(sherpa.getOfflineStreamResultAsJson(stream) || "{}");
    return detectScriptLang(j.text ?? "") ?? null;
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 本机到底能不能跑本地转写：缺什么就照实列出来。
 * 用于 providersStatus，别再用「占位」「缺 AAC 解码」这类过期说法糊人。
 */
export function availability(cfg = {}) {
  const p = resolvePaths(cfg);
  const missing = [];
  if (!p.ffmpeg) missing.push("ffmpeg（配置 ffmpegPath，或安装 imageio-ffmpeg）");
  if (!p.addon) missing.push("sherpa-onnx 原生模块（配置 sherpaAddonPath）");
  if (!existsSync(p.model)) missing.push(`SenseVoice 模型（${p.model}）`);
  if (!existsSync(p.tokens)) missing.push(`SenseVoice 词表（${p.tokens}）`);
  return { ready: missing.length === 0, missing };
}

export async function fetchSubtitles({ meta, ctx }) {
  const p = resolvePaths(ctx.cfg);
  if (!p.ffmpeg) throw ctx.error(id, "UNSUPPORTED", "找不到 ffmpeg：配置 ffmpegPath，或安装 imageio-ffmpeg");
  if (!p.addon) throw ctx.error(id, "UNSUPPORTED", "找不到 sherpa-onnx 原生模块：配置 sherpaAddonPath");
  if (!existsSync(p.model) || !existsSync(p.tokens)) throw ctx.error(id, "UNSUPPORTED", `SenseVoice 模型缺失：${p.model}`);

  const maxMin = Number(ctx.cfg.localMaxMinutes ?? 240);
  if (meta.durationS && meta.durationS / 60 > maxMin) {
    throw ctx.error(id, "UNSUPPORTED", `视频 ${(meta.durationS / 60).toFixed(0)} 分钟，超过本地转写上限 ${maxMin} 分钟`);
  }

  const headers = { Referer: "https://www.bilibili.com/" };
  const pu = await ctx.request(
    `${API}/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&fnval=16&qn=64&fourk=1`,
    { headers, signal: ctx.signal },
  );
  const audioUrl = pu?.data?.dash?.audio?.[0]?.baseUrl ?? pu?.data?.dash?.audio?.[0]?.base_url;
  if (!audioUrl) throw ctx.error(id, "AUDIO_UNAVAILABLE", "dash.audio[0] 缺失");
  let host = "";
  try {
    host = new URL(audioUrl).host;
  } catch {
    /* ignore */
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "videosub-local-"));
  const m4s = path.join(tmp, "a.m4s");
  const wav = path.join(tmp, "a.wav");
  try {
    const res = await ctx.fetchRaw(audioUrl, { headers, signal: ctx.signal });
    if (!res.ok) throw ctx.error(id, "AUDIO_UNAVAILABLE", `音频下载 HTTP ${res.status}（主机 ${host}）`);
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(m4s);
      Readable.fromWeb(res.body).pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
    });

    const dec = await runProcess(p.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", m4s, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], {
      timeoutMs: 15 * 60 * 1000,
      signal: ctx.signal,
    });
    if (dec.status !== 0 || !existsSync(wav)) {
      throw ctx.error(id, "AUDIO_UNAVAILABLE", `ffmpeg 解码失败 status=${dec.status} ${String(dec.stderr || "").slice(0, 200)}`);
    }

    const { sherpa, rec } = getRecognizer(p, ctx.cfg);
    const w = await readWavPcm16(wav);
    const sr = w.sampleRate || 16000;
    const winSamples = Math.max(5, Number(ctx.cfg.localWindowSec ?? 30)) * sr;
    const blocks = [];
    const langVotes = new Map();
    for (let start = 0; start < w.samples.length; start += winSamples) {
      if (ctx.signal?.aborted) throw ctx.error(id, "NETWORK", "已取消");
      const end = Math.min(start + winSamples, w.samples.length);
      const stream = sherpa.createOfflineStream(rec);
      sherpa.acceptWaveformOffline(stream, { samples: w.samples.subarray(start, end), sampleRate: sr });
      sherpa.decodeOfflineStream(rec, stream);
      const j = JSON.parse(sherpa.getOfflineStreamResultAsJson(stream) || "{}");
      const tag = String(j.lang ?? "").replace(/[<|>]/g, "").toLowerCase();
      if (tag && tag !== "und") langVotes.set(tag, (langVotes.get(tag) ?? 0) + 1);
      pushBlocks(blocks, j, start / sr, (end - start) / sr);
    }
    if (!blocks.length) throw ctx.error(id, "NO_SUBTITLE", "本地转写没有产出文字（音频里可能没有说话声）");
    // 语言以正文为准：实测 SenseVoice 会把日文歌的语言标签给成 ko/zh，但正文里是假名。
    // 因此：假名足够多 → 日语；否则取窗口间的多数标签；再否则按有无汉字判中文。
    const allText = blocks.map((b) => b.text).join("");
    const kanaCount = (allText.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const hanCount = (allText.match(/[\u4e00-\u9fff]/g) || []).length;
    const topTag = [...langVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "und";
    const lang = kanaCount >= 5 ? "ja" : topTag !== "und" ? topTag : hanCount > 0 ? "zh" : "und";

    const minutes = (w.samples.length / sr / 60).toFixed(1);
    return {
      source: id,
      fullAudioProcessed: true,
      note: `本地转写 ${minutes} 分钟音频（全部窗口）· 音频主机 ${host}`,
      tracks: [
        {
          lang: lang === "zh" ? "zh" : lang,
          langDesc: `本地 SenseVoice 转写（${lang}）`,
          content: blocksToSrt(blocks),
          format: "srt",
        },
      ],
    };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}