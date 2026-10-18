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
let callsThisRun = 0; // 本进程内已向该站发起的取字幕次数，用于 feiyudoMaxPerRun 上限

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

  // feiyudoMaxPerRun：本进程内最多取几条，取够就拒绝，让字幕链转去试下一个 provider
  const maxPerRun = Number(ctx.cfg.feiyudoMaxPerRun ?? 5);
  if (maxPerRun > 0 && callsThisRun >= maxPerRun) {
    throw ctx.error(id, "QUOTA", `本次运行已取 ${callsThisRun} 条，达到 feiyudoMaxPerRun=${maxPerRun} 上限`);
  }
  callsThisRun += 1;

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
      // handshake / key may be stale — refresh once and retry
      keys = null;
      lastErr = ctx.error(id, "BLOCKED", `code=${json.code} ${json.message ?? ""}`);
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
