/**
 * Provider `bcut` — Bilibili's own Bijian (必剪) anonymous ASR.
 * Not a third-party service: it is Bilibili's endpoint, no login needed.
 *
 *   playurl (dash audio baseUrl) -> POST /bcut/rubick-interface/task
 *     { resource, model_id: '8' } -> poll /task/result?model_id=8&task_id=
 *     state 1 waiting | 4 done (data.result JSON string) | 3 error
 *
 * Measured 2026-10-04: success depends on which CDN Bilibili hands out for the
 * audio URL (`*.mcdn.bilivideo.cn` usually works, `upos-sz-*` never does), and
 * even on mcdn some nodes fail. Bilibili also rate-limits: after ~13 calls in
 * one session the poll endpoint started answering HTTP 412 (not JSON), which
 * killed a whole attempt. So every attempt is wrapped: a throw counts as one
 * failed attempt, never as the end of the retry chain; between attempts we wait,
 * and a 412 waits longer.
 *
 * Language: this endpoint returns no language field and auto-detects. Do NOT
 * label output as Chinese by default — a Japanese song came back mislabelled as
 * zh. Label by evidence: kana present -> ja, otherwise "asr" (unlabelled).
 */
import { utterancesToSrt, detectScriptLang } from "../srt.js";

export const id = "bcut";
const API = "https://api.bilibili.com";
const BCUT = "https://member.bilibili.com/x/bcut/rubick-interface";

const hasKana = (t) => /[\u3040-\u309f\u30a0-\u30ff]/.test(t);
const isRateLimit = (text) => /HTTP 412|412/.test(String(text));

async function resolveAudio(meta, ctx) {
  const pu = await ctx.request(
    `${API}/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&fnval=16&qn=64&fourk=1`,
    { headers: { Referer: "https://www.bilibili.com/" }, signal: ctx.signal },
  );
  if (pu?.code !== 0) throw ctx.error(id, "NETWORK", `playurl code=${pu?.code} ${pu?.message ?? ""}`);
  const a = pu.data?.dash?.audio?.[0];
  const url = a?.baseUrl ?? a?.base_url;
  if (!url) throw ctx.error(id, "AUDIO_UNAVAILABLE", "dash.audio[0] 缺失");
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    /* keep empty host */
  }
  return { url, host };
}

async function runOnce(ctx, headers, audio) {
  const create = await ctx.request(`${BCUT}/task`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ resource: audio.url, model_id: "8" }),
    signal: ctx.signal,
  });
  if (create?.code !== 0) return { ok: false, why: `task create code=${create?.code} ${create?.message ?? ""}` };
  const taskId = create.data?.task_id;
  if (!taskId) return { ok: false, why: "task create 未返回 task_id" };

  const maxPolls = Number(ctx.cfg.bcutMaxPolls ?? 24);
  const pollMs = Number(ctx.cfg.bcutPollMs ?? 3000);
  for (let i = 0; i < maxPolls; i++) {
    await ctx.sleep(i === 0 ? Math.min(1500, pollMs) : pollMs);
    const r = await ctx.request(`${BCUT}/task/result?model_id=8&task_id=${taskId}`, { headers, signal: ctx.signal });
    const state = r?.data?.state;
    if (state === 3) return { ok: false, why: `state=3 remark='${r?.data?.remark ?? ""}'` };
    if (state === 4) {
      let parsed = {};
      try {
        parsed = JSON.parse(r.data?.result ?? "{}");
      } catch {
        return { ok: false, why: "result 不是 JSON" };
      }
      const utts = parsed.utterances ?? [];
      if (!utts.length) return { ok: false, why: "空 utterances" };
      return { ok: true, utterances: utts };
    }
  }
  return { ok: false, why: `轮询超时（${maxPolls} 次 × ${pollMs}ms）` };
}

export async function fetchSubtitles({ meta, ctx }) {
  const headers = { Referer: "https://www.bilibili.com/" };
  const tries = Math.max(1, 1 + Number(ctx.cfg.bcutRetries ?? 2));
  const baseDelay = Math.max(0, Number(ctx.cfg.bcutRetryDelayMs ?? 4000));
  const failures = [];
  let waitMs = 0;

  for (let attempt = 0; attempt < tries; attempt++) {
    if (waitMs > 0) {
      ctx.log(`[videosub] bcut 第 ${attempt + 1}/${tries} 次尝试前等待 ${waitMs}ms`);
      await ctx.sleep(waitMs);
      waitMs = 0;
    }

    let audio = null;
    let res = null;
    try {
      audio = await resolveAudio(meta, ctx);
      res = await runOnce(ctx, headers, audio);
    } catch (e) {
      const msg = String(e?.message ?? e);
      res = { ok: false, why: isRateLimit(msg) ? `被B站限流（HTTP 412）：${msg}` : `请求异常：${msg}` };
    }

    if (res.ok) {
      const content = utterancesToSrt(res.utterances);
      // 语种按正文判断（引擎不给语言字段）：中文视频以前被标成 asr，现在直接标 zh
      const byText = detectScriptLang(content);
      const japanese = byText === "ja";
      return {
        source: id,
        note: `音频主机 ${audio?.host ?? "?"}${attempt > 0 ? `（第 ${attempt + 1} 次尝试成功）` : ""}`,
        tracks: [
          {
            lang: byText ?? "asr",
            langDesc: byText ? `语音识别（${byText}）` : "ASR 自动识别（语言未标注）",
            content,
            format: "srt",
          },
        ],
      };
    }

    const host = audio?.host || "?";
    failures.push(`${host} → ${res.why}`);
    ctx.log(`[videosub] bcut 第 ${attempt + 1}/${tries} 次失败：${host} ${res.why}`);
    waitMs = baseDelay * (attempt + 1) * (isRateLimit(res.why) ? 3 : 1);
  }

  const limited = failures.some((f) => isRateLimit(f));
  throw ctx.error(
    id,
    limited ? "RATE_LIMITED" : "NO_SUBTITLE",
    `${tries} 次尝试全败${limited ? "（B站 对匿名转写接口限流，稍后再试）" : ""}：${failures.join(" ｜ ")}`,
  );
}