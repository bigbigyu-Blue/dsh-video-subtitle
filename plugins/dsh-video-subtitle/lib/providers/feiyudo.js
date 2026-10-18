/**
 * Provider `feiyudo` — third-party subtitle extractor (www.feiyudo.com).
 *
 * Handshake, replicated from their own web client:
 *   GET  <base>/api/auth/keys            -> { k1 (RSA public key), k2 }
 *   aesKey = decryptByPublicKey(k2)                       (their crypto module)
 *   body   = encryptLongByPublicKey( aesEncryptString(JSON.stringify({url}), aesKey, IV) )
 *   POST <base>/api/video/subtitleExtract   with body = JSON.stringify(body)
 *   -> data.subtitleItemVoList[].content  (already SRT)
 *
 * Body shape matters: a raw string returns 500, `{data:...}` returns 530,
 * only the encrypted string as a JSON string works.
 *
 * Zero credentials on our side: no login, no cookie, no browser. The keys are
 * fetched at runtime, so key rotation needs no code change; a scheme/endpoint
 * change means re-vendoring lib/feiyudo-cipher.js.
 */
import "../window-shim.js"; // must precede the cipher bundle: it is browser code
import { aesEncryptString, decryptByPublicKey, encryptLongByPublicKey, setKeyStore } from "../feiyudo-cipher.js";

export const id = "feiyudo";
const IV_B64 = "a2Vkb3VAODk4OSE2MzIzMw==";

let keys = null; // { aesKey, publicKey, fetchedAt }
let lastCallAt = 0;

/**
 * 该站是「按天」限流的：同一天里取够几次就回 500「您今日的使用次数已达上限，请明天再试！」。
 * 以前这里是个只增不减的进程级计数器，取满就永久拒绝，必须重启整个 DSH 才能恢复——那是 bug。
 * 现在记「日期 + 当日次数 + 站点是否已明确说今日用完」，跨天自动归零。
 */
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
let quota = { day: todayKey(), count: 0, siteExhausted: false, siteMessage: "" };

function quotaState() {
  if (quota.day !== todayKey()) quota = { day: todayKey(), count: 0, siteExhausted: false, siteMessage: "" };
  return quota;
}

const baseOf = (cfg) => String(cfg.feiyudoBaseUrl || "https://www.feiyudo.com").replace(/\/+$/, "");
const headersOf = (base) => ({
  Referer: `${base}/caption/subtitle/bilibili`,
  Origin: base,
  Accept: "application/json, text/plain, */*",
});

async function loadKeys(ctx) {
  const base = baseOf(ctx.cfg);
  const j = await ctx.request(`${base}/api/auth/keys`, { headers: headersOf(base), signal: ctx.signal });
  if (j?.code !== 200 || !j.data?.k1) {
    throw ctx.error(id, "BLOCKED", `GET /api/auth/keys code=${j?.code} ${j?.message ?? ""}`);
  }
  setKeyStore({ publicKey: j.data.k1 });
  const aesKey = decryptByPublicKey(j.data.k2);
  if (!aesKey || String(aesKey).length < 8) throw ctx.error(id, "BLOCKED", "解出的 AES 密钥为空或过短");
  return { aesKey: String(aesKey), publicKey: j.data.k1, fetchedAt: Date.now() };
}

export async function fetchSubtitles({ meta, ctx }) {
  const base = baseOf(ctx.cfg);

  // 每天最多取几条（feiyudoDailyMax，0 = 不自己限制，完全交给站点）。跨天自动归零，
  // 站点自己说今日用完了也记下来，当天不再白打请求。
  const st = quotaState();
  const dailyMax = Number(ctx.cfg.feiyudoDailyMax ?? 20);
  if (st.siteExhausted) {
    throw ctx.error(id, "QUOTA", `站点今日额度已用完（${st.siteMessage || "您今日的使用次数已达上限"}），明天自动恢复`);
  }
  if (dailyMax > 0 && st.count >= dailyMax) {
    throw ctx.error(id, "QUOTA", `今日已取 ${st.count} 条，达到 feiyudoDailyMax=${dailyMax} 上限，明天自动恢复`);
  }
  st.count += 1;

  // self-imposed rate limit — never hammer their service
  const wait = Math.max(0, Number(ctx.cfg.feiyudoMinIntervalMs ?? 3000) - (Date.now() - lastCallAt));
  if (wait > 0) await ctx.sleep(wait);

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!keys) keys = await loadKeys(ctx);

    const url = meta.raw && /bilibili\.com|b23\.tv/i.test(meta.raw)
      ? meta.raw
      : `https://www.bilibili.com/video/${meta.bvid}${meta.page > 1 ? `?p=${meta.page}` : ""}`;
    const payload = JSON.stringify({ url });
    const body = JSON.stringify(encryptLongByPublicKey(aesEncryptString(payload, keys.aesKey, IV_B64)));

    lastCallAt = Date.now();
    let res;
    try {
      res = await ctx.fetchRaw(`${base}/api/video/subtitleExtract`, {
        method: "POST",
        headers: { ...headersOf(base), "Content-Type": "application/json" },
        body,
        signal: ctx.signal,
      });
    } catch (e) {
      throw ctx.error(id, "NETWORK", e.message);
    }
    const json = await res.json().catch(() => null);
    if (!json) throw ctx.error(id, "NETWORK", `HTTP ${res.status} 响应不是 JSON`);

    if (json.code === 530 || json.code === 500) {
      // 站点说「今日次数已达上限」时不是握手问题，重试也没用，直接记下来当天不再打
      const msg = String(json.message ?? "");
      if (/次数|上限|quota|limit/i.test(msg)) {
        const s2 = quotaState();
        s2.siteExhausted = true;
        s2.siteMessage = msg;
        throw ctx.error(id, "QUOTA", `站点回复：${msg}`);
      }
      // handshake / key may be stale — refresh once and retry
      keys = null;
      lastErr = ctx.error(id, "BLOCKED", `code=${json.code} ${msg}`);
      if (attempt === 0) continue;
      throw lastErr;
    }
    if (json.code !== 200) throw ctx.error(id, "BLOCKED", `code=${json.code} ${json.message ?? ""}`);

    const items = (json.data?.subtitleItemVoList ?? []).filter((i) => i?.content && String(i.content).trim());
    if (!items.length) throw ctx.error(id, "NO_SUBTITLE", `status=${json.data?.status ?? ""}`);
    return {
      source: id,
      tracks: items.map((i) => ({
        lang: i.lang ?? "",
        langDesc: i.langDesc ?? i.lang ?? "",
        content: String(i.content),
        format: "srt",
      })),
    };
  }
  throw lastErr ?? ctx.error(id, "BLOCKED", "未知失败");
}

/** 给 providersStatus 看：今天用了多少、站点是否已说用完。 */
export function quotaStatus(cfg = {}) {
  const st = quotaState();
  const dailyMax = Number(cfg.feiyudoDailyMax ?? 20);
  return {
    day: st.day,
    used: st.count,
    dailyMax,
    siteExhausted: st.siteExhausted,
    detail: st.siteExhausted
      ? `今日额度已用完（${st.siteMessage || "站点提示次数已达上限"}），明天自动恢复`
      : dailyMax > 0
        ? `今日已取 ${st.count}/${dailyMax} 条`
        : `今日已取 ${st.count} 条（未设上限）`,
  };
}
