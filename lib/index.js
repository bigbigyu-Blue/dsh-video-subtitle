/**
 * dsh-video-subtitle — DeepSeek Harness tool plugin.
 *
 * Registers five model-facing tools on ctx.tools:
 *   subtitle_fetch      fetch a video's subtitles into a local .srt file through
 *                       a provider chain, returning metadata only
 *   subtitle_read       read a saved .srt by time range and character budget
 *   subtitle_providers  report provider-chain status for diagnostics
 *   subtitle_batch      fetch many videos (or every 分P of a collection) in one call
 *   subtitle_polish     rewrite a fetched .srt into readable sentences plus a plain
 *                       text transcript, without changing a single original character
 *
 * Deliberate design: the transcript text never enters the model context unless
 * asked for in slices — a 20-minute video is ~25k characters.
 *
 * Cordis plugin module: exports name / inject / Config / apply.
 *
 * @module dsh-video-subtitle
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  subtitleFetch,
  subtitleRead,
  polishSubtitle,
  providersStatus,
  defaultSaveDir,
  workspaceSaveDir,
  fetchTimeoutBudget,
} from "./pipeline.js";
import { batchFetch } from "./batch.js";
import { clock } from "./srt.js";
import { effectiveConfig, describeSettings } from "./settings.js";
import { registerApiRoutes } from "./api.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "videosub";

/** 版本号直接从 package.json 读，免得两个地方各写一份对不上。 */
const VERSION = (() => {
  try {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    return String(JSON.parse(readFileSync(file, "utf8")).version ?? "");
  } catch {
    return "";
  }
})();

/** Services required by the tool plugin. */
const inject = ["tools", "systemPrompt"];

/** Deployment-tunable config, filled by the loader from the patch row. */
const Config = z.object({
  enabled: z.boolean().default(true),
  providerOrder: z.array(z.string()).default(["native", "ytdlp", "whisper", "local"]),
  saveDir: z.string().default(""),
  saveToWorkspace: z.boolean().default(true),
  workspaceSubdir: z.string().default(".subtitles"),
  preferLang: z.array(z.string()).default(["zh", "en"]),
  timeoutMs: z.number().default(90000),
  // 本机 faster-whisper 转写（不依赖外部服务、无次数限制，代价是慢）
  whisperPython: z.string().default(""),
  whisperHfHome: z.string().default(""),
  whisperTmpDir: z.string().default(""),
  whisperModel: z.string().default("small"),
  whisperThreads: z.number().default(4),
  // 批处理一次喂给模型的音频窗口数；实测比逐段转写快约 1.25 倍，0 = 关掉批处理退回逐段
  whisperBatchSize: z.number().default(8),
  // 批处理拿到的词级时间戳按多少字收一条字幕，越小越细碎
  whisperMaxChars: z.number().default(24),
  whisperLang: z.string().default("auto"),
  whisperTimeoutMs: z.number().default(1800000),
  whisperMaxMinutes: z.number().default(180),
  // 转写进程常驻复用：模型只加载一次，连着取多条时后面的明显更快；关掉则每条新开进程（排障对比用）
  whisperReuseModel: z.boolean().default(true),
  fullCoveragePct: z.number().default(90),
  keepOnlyOriginalLang: z.boolean().default(true),
  localWindowSec: z.number().default(30),
  localThreads: z.number().default(4),
  localMaxMinutes: z.number().default(240),
  localProbeSec: z.number().default(60),
  ffmpegPath: z.string().default(""),
  sherpaAddonPath: z.string().default(""),
  senseVoiceModel: z.string().default(""),
  senseVoiceTokens: z.string().default(""),
  cacheTtlDays: z.number().default(30),
  // B站 登录凭据：登录 + WBI 签名才拿得到官方 AI 字幕轨，匿名一律没有
  biliCookie: z.string().default(""),
  biliCredentialFile: z.string().default(""),
  // 批量取字幕单次最多跑几条（合集分P很多时防止一次跑太久），被截掉的条数会如实报出来
  batchMaxItems: z.number().default(20),
  // 借来的下载器（B站 以外的站用它取字幕与声音）：留空 = 用设置页一键安装装到插件目录里那份
  ytdlpPath: z.string().default(""),
});

const SYSTEM_PROMPT = [
  "Use the video subtitle tools for Bilibili videos (bare BV id, bare av id, bilibili.com/video/BV... or /av..., b23.tv short link, ?p= 分P) and for any other video site whose link the bundled downloader knows (YouTube and about a thousand others; pass the full watch URL).",
  "【别的站】B站 以外的站走借来的下载器：先取站上现成的字幕（人工优先，其次站上自动生成的），站上真没有才把声音取下来交给本机转写。整张播放列表、整个频道不展开，一次只处理给的那一条，要说明只取了这一条。要登录才给看的站如实说清，不替用户登录。",
  "【取字幕】subtitle_fetch(url)：把字幕写入本地 .srt 文件，只回元数据（标题、时长、字数、路径）。正文不会进入上下文。",
  "【落盘位置】默认写进发起这次调用的那个会话自己的工作区，子目录 workspaceSubdir（默认 .subtitles）；取不到会话工作区才退回 <DSH_HOME>/subtitles。传 dir 参数可指定别处。",
  "【读正文】subtitle_read(path, from, to, max_chars)：按时间区间分段读。20 分钟视频约 2.5 万字，禁止一次整篇读。",
  "【失败处理】subtitle_fetch 返回 ok:false 时，先把 hints[] 里「下一步」原样告诉用户，再如实转述 attempts[] 里每个 provider 的原因；不要编造字幕内容，不要改用别的视频替代，也不要声称已获取。",
  "【排障】subtitle_providers 报告各 provider 的接线状态与最近一次结果（哪个源缺什么、上次为什么失败，在这里一眼可见）。",
  "【批量】subtitle_batch(urls, parts, lang, dir, force, max_items)：一次取多条。urls 给数组或一整段粘贴的文本（换行/逗号分隔都行）；parts=true 时先把合集的分P全部展开再逐个取，适合多集课程/连续剧。某一条失败不影响其它条，每条都有独立结果；条数超上限时如实告诉你还剩几条没取。",
  "【整理】subtitle_polish(path, dir, max_gap, max_chars)：把取回来的 .srt 拼回通顺句子并补标点，另写一份纯文稿 .txt。只做拼接和插入标点，一个原字都不改、不译、不删。B站 官方 AI 字幕是逐句短碎片、完全没有标点，要给人读或做总结就先用它整理一遍。",
  "provider 顺序默认 native→ytdlp→whisper→local，在 profile 的 cordis.patch.yml 里可改。",
  "ytdlp 是「站上现成字幕」，靠的下载器叫 yt-dlp（免费开源的小程序，用户可以自己查）：B站 上它自己跳过（B站 走官方接口更快更全），别的站先问站上有没有现成字幕轨，人工优先、站上自动生成的其次，要的语种没有就取视频原文语种那条。下载器没装或起不来时它报 DOWNLOADER_MISSING，这时让用户到「设置 → 视频字幕」页的「下载器 yt-dlp」卡片点一键安装或重新检查，不要说视频没有字幕。",
  "native 是主力源：B站 官方 AI 字幕轨要「已登录 + WBI 签名」才会返回地址，匿名拿不到。插件自动读本机已有登录凭据（biliCredentialFile 或 biliCookie），通常在 1 秒内返回。拿不到时先看 subtitle_providers 里 native 那行写的凭据状态，不要去猜视频没有字幕。",
  "whisper 是用 Whisper 引擎在本机转字幕，任何有声音的视频都能转但慢（约每分钟音频 8 秒），没有次数限制；它转的是整段音频，结果标记为完整。",
  "local 是用 SenseVoice 引擎在本机转字幕，和 whisper 是两个不同的引擎，通常比 whisper 快一倍左右、覆盖更全，但断句更碎、个别视频会漏句。它需要三样零件（FFmpeg、SenseVoice 模型、模型词表，共约 260MB），在设置里的「视频字幕」页点一键安装就能装齐，不需要 Python。装好前它在 subtitle_providers 里会显示为可选、缺件；缺件时如实告诉用户去设置页装，不要因此说视频没有字幕。",
].join("\n");

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

function covText(t) {
  if (t.coveragePct == null) return "";
  const warn = t.coveragePct < 60 ? "  ⚠ 覆盖不足，可能只转了一小段" : "";
  return ` · 覆盖 ${clock(t.firstSec)}–${clock(t.lastSec)}（视频的 ${t.coveragePct}%）${warn}`;
}

/** 落盘目录来源的说明后缀，用于把"写到哪、为什么写到那"直接呈现在工具回执里。 */
const DIR_SOURCE_NOTE = {
  workspace: "（= 发起本次调用的会话工作区）",
  arg: "（dir 参数指定）",
  config: "（配置 saveDir）",
  fallback: "（兜底目录：没取到会话工作区）",
};

function fmtFetch(v) {
  if (!v) return "subtitle_fetch 没有返回结果";
  const lines = [];
  // 视频编号那一栏：B站 写 BVID，别的站写站上那个视频自己的编号，再看不出就写网址主机
  const idLine = v.platform === "bilibili"
    ? `BVID ${v.bvid}${v.page > 1 ? ` P${v.page}` : ""}`
    : `${v.site ? `${v.site} ` : ""}编号 ${v.videoId ?? "?"}`;
  if (v.ok) {
    lines.push(`${v.cached ? "命中缓存" : "已取到字幕"}：${v.title}`);
    lines.push(
      `${idLine} | 时长 ${clock(v.durationS)} | 来源 ${v.source} | 耗时 ${v.elapsedMs}ms`,
    );
    if (v.dir) lines.push(`落盘目录：${v.dir}${DIR_SOURCE_NOTE[v.dirSource] ?? ""}`);
    for (const t of v.tracks ?? []) {
      lines.push(`- ${t.lang || t.langDesc || t.language}（${t.language}）${t.chars} 字 / ${t.blocks} 段${covText(t)} → ${t.path}${t.picked ? "   ← 推荐" : ""}`);
    }
    if (v.langNote) lines.push(`语言：${v.langNote}`);
    lines.push("正文未进入上下文。需要内容时用 subtitle_read(path, from, to) 按区间读。");
    if (v.metaPath) lines.push(`元数据：${v.metaPath}`);
  } else {
    // 别的站 bvid 是空串，用 ?? 会停在空串上，整行就空了，所以这里用 ||
    lines.push(`取字幕失败：${v.title || v.bvid || v.videoId || v.site || ""}`);
    lines.push(`${idLine} | 目录 ${v.dir}`);
    if (v.partial) {
      lines.push(`文稿不完整：只覆盖 ${v.coveragePct ?? "?"}%，未达可用线。**已丢弃、没有写文件。不能作为谈论视频内容的依据。**`);
    }
    // 先说该干什么，再说为什么。只报原因的话，看的人不知道下一步要动哪。
    const hints = Array.isArray(v.hints) ? v.hints.filter(Boolean) : [];
    if (hints.length) {
      lines.push("下一步：");
      for (const h of hints) lines.push(`- ${h}`);
    }
    lines.push("各 provider 尝试结果：");
    for (const a of v.attempts ?? []) {
      lines.push(`- ${a.provider}: ${a.result}${a.detail ? ` — ${a.detail}` : ""} (${a.ms ?? "-"}ms)`);
    }
    lines.push(v.partial
      ? "文稿不完整、按用户要求已丢弃：不要基于它谈论视频内容，如实告诉用户没拿到完整文稿。"
      : "不要编造字幕内容，也不要换别的视频充数；把上面的原因和「下一步」如实告诉用户。");
  }
  return lines.join("\n");
}

function fmtRead(v) {
  const tail = v.cutLine
    ? " | 有一条字幕过长，本次只给出前半截，其后内容未显示"
    : v.truncated
      ? " | 已截断（继续读请传起始时间）"
      : "";
  const head = `读取 ${v.path} | 命中 ${v.matchedBlocks}/${v.totalBlocks} 段 | 本次 ${v.lines} 行 ${v.chars} 字${tail}`;
  const rangeNote = v.range && (v.range.from != null || v.range.to != null) ? ` | 区间 ${v.range.from ?? "起"}~${v.range.to ?? "止"}s` : "";
  return `${head}${rangeNote}\n${v.text || "（该区间没有内容）"}`;
}

function fmtBatch(v) {
  const lines = [];
  const bad = (v.items ?? []).filter((it) => !it.ok).length;
  lines.push(
    `批量取字幕：共 ${v.total} 条 | 成功 ${vItemsOk(v)} | 失败 ${bad} | 跳过 ${v.skipped ?? 0} | 用时 ${Math.round((v.elapsedMs ?? 0) / 1000)} 秒`,
  );
  if (v.aborted) lines.push("中途被取消，下面是取消前已经跑完的部分。");
  if (v.truncated > 0) lines.push(`还有 ${v.truncated} 条没取（单次上限），要取完请再调一次并只传剩下的链接。`);
  lines.push("");
  for (const it of v.items ?? []) {
    const tag = it.page && it.page > 1 ? ` P${it.page}` : "";
    // 别的站没有 BVID：有站上编号就写编号，没有就写网址，别让整行空着
    const head = it.bvid ? `${it.bvid}${tag}` : it.videoId ? `${it.videoId}${tag}` : String(it.url ?? "?").slice(0, 60);
    if (it.ok) {
      const cov = it.coveragePct == null ? "" : ` · 覆盖 ${it.coveragePct}%`;
      lines.push(`✔ ${head}「${it.title || "无标题"}」${it.cached ? " · 命中已有文件" : ` · 来源 ${it.source ?? "?"}`} · ${it.chars} 字 / ${it.blocks} 段${cov}`);
      for (const t of it.tracks ?? []) lines.push(`    → ${t.language} ${t.chars} 字：${t.path}`);
    } else {
      lines.push(`✘ ${head}「${it.title || "无标题"}」：${it.error ?? "原因未知"}`);
      for (const h of it.hints ?? []) lines.push(`    下一步：${h}`);
    }
  }
  lines.push("");
  lines.push(`合计 ${v.totalChars} 字。正文未进入上下文；要看内容用 subtitle_read(path, from, to)，要给人读的版本用 subtitle_polish(path)。`);
  return lines.join("\n");
}

/** 成功条数单独算：total 里含跳过项，不能拿 total 减失败。 */
function vItemsOk(v) {
  return (v.items ?? []).filter((it) => it.ok).length;
}

function fmtPolish(v) {
  const s = v.stats ?? {};
  const lines = [
    `已整理：${v.path}`,
    `段落 ${s.before ?? "?"} → ${s.after ?? "?"} 段（并掉 ${s.merged ?? 0} 段，补标点 ${s.punctuated ?? 0} 段），${v.chars ?? 0} 字`,
    `可读字幕：${v.srtPath}`,
    `纯文稿：${v.textPath}`,
    "只做了拼接与插入标点，原文一个字都没改。正文未进入上下文；要读纯文稿直接读那个 .txt 文件。",
  ];
  return lines.join("\n");
}

function fmtStatus(v) {
  const lines = [`provider 顺序：${(v.order ?? []).join(" → ")}`, `字幕目录：${v.saveDir}`];
  lines.push(
    v.saveToWorkspace
      ? `落盘策略：默认写发起会话的工作区，子目录 ${v.workspaceSubdir}；取不到会话工作区则退回 ${v.fallbackDir}`
      : `落盘策略：固定目录（saveToWorkspace=false），实际目录 ${v.fallbackDir}`,
  );
  for (const p of v.providers ?? []) {
    const last = p.lastResult ? `最近一次：${p.lastResult}${p.lastDetail ? ` — ${p.lastDetail}` : ""} @ ${p.lastAt}` : "最近一次：本进程内未调用";
    const extra = p.placeholder ? `（${p.placeholder}）` : p.note ? `（${p.note}）` : "";
    lines.push(`- ${p.provider}${p.wired ? "" : "（未接线）"}${extra}：${last}`);
  }
  return lines.join("\n");
}

function apply(ctx, config) {
  const cfg = { ...(config ?? {}) };
  if (cfg.enabled === false) return;
  // 每次真要干活时重新算一遍：界面上的设置存盘后立刻生效，不用重启插件
  const cfgNow = () => effectiveConfig(cfg);
  const log = (m) => {
    try {
      ctx.logger?.info?.(m);
    } catch {
      /* logging must never break the tool */
    }
  };

  ctx.systemPrompt.section({ name: "tool:video_subtitle", order: 165, text: SYSTEM_PROMPT });

  // 设置页用的 HTTP 接口。宿主没开 webServer 就只是没有设置页，取字幕不受影响，所以不写进 inject。
  ctx.inject(["webServer"], (host) => {
    host.effect(() => registerApiRoutes(host, { getCfg: cfgNow, version: VERSION }), "dsh-video-subtitle: http routes");
  });

  ctx.tools.register(
    defineTool({
      name: "subtitle_fetch",
      description:
        "Fetch a video's subtitles into a local .srt file through a fallback provider chain " +
        "(bilibili official API with your local login credential -> local faster-whisper ASR -> local SenseVoice ASR). " +
        "Returns metadata only (title, duration, per-track character counts, absolute file paths); the " +
        "transcript text is NOT returned — read it on demand with subtitle_read. A result counts as success " +
        "only when the transcript covers at least fullCoveragePct (default 90%) of the video; anything shorter " +
        "is returned as ok:false with partial:true and must NOT be treated as the video's content. Use it when the user " +
        "asks about a Bilibili video and you need its spoken content, or when a subtitle file is wanted. " +
        "By default the file is written into the calling session's own workspace (subdirectory from config " +
        "workspaceSubdir, default .subtitles); pass dir to write somewhere else.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "Video URL. Bilibili: bilibili.com/video/BV... or /av..., b23.tv, or a bare BV/av id (?p= selects a 分P). Other sites: the full watch URL (YouTube and any site the bundled downloader knows); one video at a time, playlists and channels are not expanded",
        },
        lang: { type: "string", description: "Preferred subtitle language, e.g. zh or en (default: config preferLang)" },
        dir: { type: "string", description: "Output directory for the .srt file (default: config saveDir, else the calling session's workspace subdir, else <DSH_HOME>/subtitles)" },
        force: { type: "boolean", description: "Ignore the local cache and fetch again (default false)" },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: fmtFetch(value) }],
      },
      // 等待上限跟着 providerOrder 的实际源数量走，不再固定按 4 个源算死
      timeoutMs: fetchTimeoutBudget(cfg),
      async execute(args, exec) {
        return subtitleFetch({
          url: args.url,
          lang: args.lang,
          dir: args.dir,
          force: args.force === true,
          cfg: cfgNow(),
          signal: exec.signal,
          log,
          workspaceRoot: exec?.agent?.session?.header?.cwd ?? "",
        });
      },
      presentCall: (args) => ({ card: "generic", title: args.url, kind: "fetch", rawInput: args.url }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "subtitle_read",
      description:
        "Read a saved .srt file (created by subtitle_fetch) as compact [MM:SS] lines, optionally limited " +
        "to a time range and a character budget. Use it to pull only the part of a long transcript you " +
        "actually need instead of flooding the context.",
      parameters: {
        path: { type: "string", required: true, description: "Absolute path of the .srt file returned by subtitle_fetch" },
        from: { type: "number", description: "Start time in seconds (inclusive)" },
        to: { type: "number", description: "End time in seconds (inclusive)" },
        max_chars: { type: "integer", description: "Character budget for this call (default 6000, max 60000)" },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: fmtRead(value) }],
      },
      timeoutMs: 30000,
      async execute(args) {
        return subtitleRead({
          path: args.path,
          from: args.from,
          to: args.to,
          maxChars: clampInt(args.max_chars, 6000, 200, 60000),
        });
      },
      presentCall: (args) => ({ card: "generic", title: args.path, kind: "read", rawInput: args.path }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "subtitle_batch",
      description:
        "Fetch subtitles for MANY videos in one call, or for every 分P of a collection when parts=true. " +
        "urls accepts an array or one pasted blob (newlines / commas / spaces). Each item gets its own " +
        "ok/error, so one dead link never sinks the batch. Returns metadata only — same rule as subtitle_fetch: " +
        "no transcript text enters the context. Items beyond max_items are reported as truncated, never silently dropped.",
      parameters: {
        urls: { type: "string", required: true, description: "One or more video links/ids, separated by newlines, commas or spaces (or pass a JSON array)" },
        parts: { type: "boolean", description: "true = expand every 分P of a collection into its own target first (default false)" },
        lang: { type: "string", description: "Preferred subtitle language, e.g. zh or en" },
        dir: { type: "string", description: "Output directory (default follows the plugin's saveToWorkspace / saveDir policy)" },
        force: { type: "boolean", description: "Ignore the local cache and fetch again (default false)" },
        max_items: { type: "integer", description: "Max targets to process in this call (default batchMaxItems, 20)" },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: fmtBatch(value) }],
      },
      // 批量是串行跑：每条都可能走到本机转写，上限按单条预算乘条数算，再加取视频信息的余量
      timeoutMs: fetchTimeoutBudget(cfg) * clampInt(cfg.batchMaxItems, 20, 1, 100) + 60000,
      async execute(args, exec) {
        let urls = args.urls;
        // 参数声明成字符串，是为了让人能整段粘贴；数组同样接受
        if (typeof urls === "string") {
          const t = urls.trim();
          if (t.startsWith("[")) {
            try {
              const arr = JSON.parse(t);
              if (Array.isArray(arr)) urls = arr.map((x) => String(x));
            } catch {
              /* 不是合法 JSON 就按分隔符切开，跟普通粘贴一样处理 */
            }
          }
        }
        return batchFetch({
          urls,
          parts: args.parts === true,
          lang: args.lang,
          dir: args.dir,
          force: args.force === true,
          cfg: cfgNow(),
          signal: exec.signal,
          log,
          workspaceRoot: exec?.agent?.session?.header?.cwd ?? "",
          maxItems: clampInt(args.max_items, clampInt(cfg.batchMaxItems, 20, 1, 100), 1, 100),
        });
      },
      presentCall: (args) => ({ card: "generic", title: "批量取字幕", kind: "fetch", rawInput: String(args.urls ?? "").slice(0, 80) }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "subtitle_polish",
      description:
        "Turn a fetched .srt into something a human can read: merge the fragment lines back into sentences by " +
        "time gap, insert punctuation, and write both a cleaned .srt and a plain .txt transcript next to it. " +
        "It only joins and inserts punctuation — it never rewrites, deletes, translates or reorders a single " +
        "original character. Use it before quoting, summarizing or showing subtitles to the user, because " +
        "Bilibili's AI subtitles ship as punctuation-free fragments.",
      parameters: {
        path: { type: "string", required: true, description: "Absolute path of a .srt file created by subtitle_fetch" },
        dir: { type: "string", description: "Where to write the cleaned files (default: same directory as the input)" },
        max_gap: { type: "number", description: "Merge fragments whose gap is at most this many seconds (default 0.6)" },
        max_chars: { type: "number", description: "Never let a merged sentence exceed this many characters (default 42)" },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: fmtPolish(value) }],
      },
      timeoutMs: 60000,
      async execute(args) {
        return polishSubtitle({
          path: args.path,
          dir: args.dir,
          maxGap: args.max_gap,
          maxChars: args.max_chars,
        });
      },
      presentCall: (args) => ({ card: "generic", title: args.path, kind: "write", rawInput: args.path }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "subtitle_providers",
      description:
        "Report the subtitle provider chain: which providers are wired, and each one's last attempt " +
        "result and reason. Use it to diagnose a failed fetch, or to see whether the login credential " +
        "still works and whether the local speech environment is installed.",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: fmtStatus(value) }],
      },
      timeoutMs: 15000,
      async execute() {
        const live = cfgNow();
        const subdir = live.workspaceSubdir || ".subtitles";
        const fallbackDir = live.saveDir || defaultSaveDir();
        return {
          providers: providersStatus(live),
          order: live.providerOrder ?? [],
          saveToWorkspace: live.saveToWorkspace !== false,
          workspaceSubdir: subdir,
          fallbackDir,
          saveDir: live.saveToWorkspace === false ? fallbackDir : `<会话工作区>\\${subdir}`,
          settings: describeSettings(cfg),
        };
      },
    }),
  );
}

export { Config, apply, inject, name };
export { subtitleFetch, subtitleRead, polishSubtitle, providersStatus, defaultSaveDir, workspaceSaveDir } from "./pipeline.js";
export { batchFetch, parseBatchSpec, expandTargets } from "./batch.js";
export { polishSrt, assembleSentences, addPunctuation, toPlainText } from "./text-format.js";
