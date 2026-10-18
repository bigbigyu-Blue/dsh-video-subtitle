/**
 * dsh-video-subtitle — DeepSeek Harness tool plugin.
 *
 * Registers three model-facing tools on ctx.tools:
 *   subtitle_fetch      fetch a video's subtitles into a local .srt file through
 *                       a provider chain, returning metadata only
 *   subtitle_read       read a saved .srt by time range and character budget
 *   subtitle_providers  report provider-chain status for diagnostics
 *
 * Deliberate design: the transcript text never enters the model context unless
 * asked for in slices — a 20-minute video is ~25k characters.
 *
 * Cordis plugin module: exports name / inject / Config / apply.
 *
 * @module dsh-video-subtitle
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { subtitleFetch, subtitleRead, providersStatus, defaultSaveDir, workspaceSaveDir, fetchTimeoutBudget } from "./pipeline.js";
import { clock } from "./srt.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "videosub";

/** Services required by the tool plugin. */
const inject = ["tools", "systemPrompt"];

/** Deployment-tunable config, filled by the loader from the patch row. */
const Config = z.object({
  enabled: z.boolean().default(true),
  providerOrder: z.array(z.string()).default(["native", "feiyudo", "bcut", "local"]),
  saveDir: z.string().default(""),
  saveToWorkspace: z.boolean().default(true),
  workspaceSubdir: z.string().default(".subtitles"),
  preferLang: z.array(z.string()).default(["zh", "en"]),
  timeoutMs: z.number().default(90000),
  feiyudoBaseUrl: z.string().default("https://www.feiyudo.com"),
  feiyudoMinIntervalMs: z.number().default(3000),
  feiyudoMaxPerRun: z.number().default(5),
  bcutPollMs: z.number().default(3000),
  bcutMaxPolls: z.number().default(24),
  bcutRetries: z.number().default(2),
  bcutRetryDelayMs: z.number().default(4000),
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
});

const SYSTEM_PROMPT = [
  "Use the video subtitle tools for Bilibili videos (bare BV id, bare av id, bilibili.com/video/BV... or /av..., b23.tv short link, ?p= 分P).",
  "【取字幕】subtitle_fetch(url)：把字幕写入本地 .srt 文件，只回元数据（标题、时长、字数、路径）。正文不会进入上下文。",
  "【落盘位置】默认写进发起这次调用的那个会话自己的工作区，子目录 workspaceSubdir（默认 .subtitles）；取不到会话工作区才退回 <DSH_HOME>/subtitles。传 dir 参数可指定别处。",
  "【读正文】subtitle_read(path, from, to, max_chars)：按时间区间分段读。20 分钟视频约 2.5 万字，禁止一次整篇读。",
  "【失败处理】subtitle_fetch 返回 ok:false 时，把 attempts[] 里每个 provider 的原因如实转述，不要编造字幕内容，不要改用别的视频替代，也不要声称已获取。",
  "【排障】subtitle_providers 报告各 provider 的接线状态与最近一次结果（第三方站点改版、抽签失败在这里一眼可见）。",
  "provider 顺序默认 native→feiyudo→bcut→local，在 profile 的 cordis.patch.yml 里可改；第三方站换域名改 feiyudoBaseUrl。",
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
  if (v.ok) {
    lines.push(`${v.cached ? "命中缓存" : "已取到字幕"}：${v.title}`);
    lines.push(
      `BVID ${v.bvid}${v.page > 1 ? ` P${v.page}` : ""} | 时长 ${clock(v.durationS)} | 来源 ${v.source} | 耗时 ${v.elapsedMs}ms`,
    );
    if (v.dir) lines.push(`落盘目录：${v.dir}${DIR_SOURCE_NOTE[v.dirSource] ?? ""}`);
    for (const t of v.tracks ?? []) {
      lines.push(`- ${t.lang || t.langDesc || t.language}（${t.language}）${t.chars} 字 / ${t.blocks} 段${covText(t)} → ${t.path}${t.picked ? "   ← 推荐" : ""}`);
    }
    if (v.langNote) lines.push(`语言：${v.langNote}`);
    lines.push("正文未进入上下文。需要内容时用 subtitle_read(path, from, to) 按区间读。");
    if (v.metaPath) lines.push(`元数据：${v.metaPath}`);
  } else {
    lines.push(`取字幕失败：${v.title ?? v.bvid}`);
    lines.push(`BVID ${v.bvid}${v.page > 1 ? ` P${v.page}` : ""} | 目录 ${v.dir}`);
    if (v.partial) {
      lines.push(`文稿不完整：只覆盖 ${v.coveragePct ?? "?"}%，未达可用线。**已丢弃、没有写文件。不能作为谈论视频内容的依据。**`);
    }
    lines.push("各 provider 尝试结果：");
    for (const a of v.attempts ?? []) {
      lines.push(`- ${a.provider}: ${a.result}${a.detail ? ` — ${a.detail}` : ""} (${a.ms ?? "-"}ms)`);
    }
    lines.push(v.partial
      ? "文稿不完整、按用户要求已丢弃：不要基于它谈论视频内容，如实告诉用户没拿到完整文稿。"
      : "不要编造字幕内容，也不要换别的视频充数；把上面的原因如实告诉用户。");
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

function fmtStatus(v) {
  const lines = [`provider 顺序：${(v.order ?? []).join(" → ")}`, `字幕目录：${v.saveDir}`];
  lines.push(
    v.saveToWorkspace
      ? `落盘策略：默认写发起会话的工作区，子目录 ${v.workspaceSubdir}；取不到会话工作区则退回 ${v.fallbackDir}`
      : `落盘策略：固定目录（saveToWorkspace=false），实际目录 ${v.fallbackDir}`,
  );
  for (const p of v.providers ?? []) {
    const last = p.lastResult ? `最近一次：${p.lastResult}${p.lastDetail ? ` — ${p.lastDetail}` : ""} @ ${p.lastAt}` : "最近一次：本进程内未调用";
    lines.push(`- ${p.provider}${p.wired ? "" : "（未接线）"}${p.placeholder ? `（${p.placeholder}）` : ""}：${last}`);
  }
  return lines.join("\n");
}

function apply(ctx, config) {
  const cfg = { ...(config ?? {}) };
  if (cfg.enabled === false) return;
  const log = (m) => {
    try {
      ctx.logger?.info?.(m);
    } catch {
      /* logging must never break the tool */
    }
  };

  ctx.systemPrompt.section({ name: "tool:video_subtitle", order: 165, text: SYSTEM_PROMPT });

  ctx.tools.register(
    defineTool({
      name: "subtitle_fetch",
      description:
        "Fetch a video's subtitles into a local .srt file through a fallback provider chain " +
        "(bilibili native API -> third-party extractor -> Bcut anonymous ASR -> local ASR). " +
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
          description: "Bilibili video URL (bilibili.com/video/BV... or /av..., b23.tv) or a bare BV/av id; ?p= selects a 分P",
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
          cfg,
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
      name: "subtitle_providers",
      description:
        "Report the subtitle provider chain: which providers are wired, and each one's last attempt " +
        "result and reason. Use it to diagnose a failed fetch, or to check whether the third-party " +
        "subtitle site changed its API.",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: fmtStatus(value) }],
      },
      timeoutMs: 15000,
      async execute() {
        const subdir = cfg.workspaceSubdir || ".subtitles";
        const fallbackDir = cfg.saveDir || defaultSaveDir();
        return {
          providers: providersStatus(cfg),
          order: cfg.providerOrder ?? [],
          saveToWorkspace: cfg.saveToWorkspace !== false,
          workspaceSubdir: subdir,
          fallbackDir,
          saveDir: cfg.saveToWorkspace === false ? fallbackDir : `<会话工作区>\\${subdir}`,
        };
      },
    }),
  );
}

export { Config, apply, inject, name };
export { subtitleFetch, subtitleRead, providersStatus, defaultSaveDir, workspaceSaveDir } from "./pipeline.js";
