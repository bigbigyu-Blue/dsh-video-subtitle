/**
 * 声音从哪来：B站 走官方接口，别的站交给下载器。
 *
 * 为什么单独一个文件：两条本机转写（Whisper 与 SenseVoice）都要「一段能读的本地音频文件」。
 * 以前它们各自写了一遍「问 playurl 拿地址再下载」，那段代码只认 B站；现在 B站 以外的站
 * 也要能转写，取声音这一处按平台分岔就够了，转写那一段一行不用改。
 *
 * 约定：调用方给一个能写的临时目录，这里把音频文件落在里面，返回它的绝对路径。
 * 临时目录由调用方在 finally 里整个删掉，这里不删。
 */
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { downloadAudio } from "./ytdlp.js";

const API = "https://api.bilibili.com";
const REFERER = "https://www.bilibili.com/";

/**
 * 取一段能转写的声音。
 * @param {object} args
 * @param {object} args.meta 视频信息（B站 有 bvid/cid，别的站有 url 与 id）
 * @param {object} args.ctx 来源上下文（cfg / signal / request / fetchRaw / error）
 * @param {string} args.tmp 已经建好的临时目录
 * @param {string} args.provider 来源名，报错时带上是哪条路失败
 * @returns {Promise<{path:string, host:string}>}
 */
export async function fetchAudio({ meta, ctx, tmp, provider = "" }) {
  if (meta?.platform === "bilibili") return fetchBilibiliAudio({ meta, ctx, tmp, provider });
  return fetchOtherSiteAudio({ meta, ctx, tmp, provider });
}

/** B站：问 playurl 要地址，再按地址把音频下到本地。 */
async function fetchBilibiliAudio({ meta, ctx, tmp, provider }) {
  if (!meta.bvid || !meta.cid) {
    throw ctx.error(provider, "AUDIO_UNAVAILABLE", "B站 链接里缺视频编号，取不到声音");
  }
  const headers = { Referer: REFERER };
  const pu = await ctx.request(
    `${API}/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&fnval=16&qn=64&fourk=1`,
    { headers, signal: ctx.signal },
  );
  const audio = pu?.data?.dash?.audio?.[0];
  const audioUrl = audio?.baseUrl ?? audio?.base_url;
  if (!audioUrl) throw ctx.error(provider, "AUDIO_UNAVAILABLE", "dash.audio[0] 缺失");

  // 匿名 playurl 对一部分视频只给「试看片段」（实测某 72 分钟视频只给 616 秒音频），
  // dash.duration 会如实写出这个片段长度。不比对就会把「只转了一小段」当成整段转完。
  const dashDur = Number(pu?.data?.dash?.duration ?? 0);
  const fullS = Number(meta.durationS ?? 0);
  if (dashDur > 0 && fullS > 0 && dashDur < fullS * 0.95) {
    throw ctx.error(
      provider,
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

  const file = path.join(tmp, "a.m4s");
  const res = await ctx.fetchRaw(audioUrl, { headers, signal: ctx.signal });
  if (!res.ok) throw ctx.error(provider, "AUDIO_UNAVAILABLE", `音频下载 HTTP ${res.status}（主机 ${host}）`);
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(file);
    Readable.fromWeb(res.body).pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
  return { path: file, host };
}

/** 别的站：让下载器把声音取下来。它自己认站、自己报错。 */
async function fetchOtherSiteAudio({ meta, ctx, tmp, provider }) {
  const r = await downloadAudio({ url: meta.raw, dir: tmp, cfg: ctx.cfg, signal: ctx.signal });
  const file = r?.path;
  if (!file) throw ctx.error(provider, "AUDIO_UNAVAILABLE", "下载器没有给出音频文件");
  try {
    await fs.access(file);
  } catch {
    throw ctx.error(provider, "AUDIO_UNAVAILABLE", "下载器说取到了声音，但文件不在");
  }
  let host = "";
  try {
    host = new URL(meta.raw).host;
  } catch {
    /* ignore */
  }
  return { path: file, host };
}
