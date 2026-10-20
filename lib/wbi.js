/**
 * B站 WBI 签名（/x/player/wbi/v2 等接口的前置条件）。
 *
 * 纯算法，不发请求：调用方自己把 img_key / sub_key 取来喂进来。
 * 取 key 用 nav 接口（匿名即可），签名规则见 SocialSisterYi/bilibili-API-collect 的 wbi.md：
 * 参数按名排序拼 query，值里去掉 !'()* 五个字符，末尾拼上重排后的 mixinKey 再做 md5。
 */
import { createHash } from "node:crypto";

const API = "https://api.bilibili.com";

/** mixinKey 的取字符顺序（B站 前端写死的表，改不了）。 */
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

const KEY_TTL_MS = 60 * 60 * 1000; // 官方每天换一次 key，一小时取一次足够
const keyCache = { at: 0, imgKey: "", subKey: "" };

/** 从 nav 的 img_url / sub_url 里取出两段 key（文件名去掉扩展名）。 */
export function extractKeys(wbiImg) {
  const pick = (u) => String(u ?? "").split("/").pop().split(".")[0] ?? "";
  const imgKey = pick(wbiImg?.img_url);
  const subKey = pick(wbiImg?.sub_url);
  return { imgKey, subKey };
}

/** 两段 key 按 MIXIN 重排、拼起来取前 32 位，就是 mixinKey。 */
export function mixinKey(imgKey, subKey) {
  const raw = String(imgKey ?? "") + String(subKey ?? "");
  let out = "";
  for (const i of MIXIN) {
    if (i < raw.length) out += raw[i];
  }
  return out.slice(0, 32);
}

/** 值里要去掉的五个字符（B站 的规则，不是随意订的）。 */
const clean = (v) => String(v ?? "").replace(/[!'()*]/g, "");

/**
 * 给参数签名，返回可直接拼到 URL 后面的 query 串。
 * @param {Record<string,string|number>} params
 * @param {{imgKey:string, subKey:string}} keys
 * @param {number} [nowMs] 仅测试用，固定时间方便断言
 */
export function wbiSign(params, keys, nowMs = Date.now()) {
  const mk = mixinKey(keys?.imgKey, keys?.subKey);
  const p = { ...params, wts: String(Math.floor(nowMs / 1000)) };
  const names = Object.keys(p).sort();
  const pairs = names.map((k) => [k, clean(p[k])]);
  const query = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const wRid = createHash("md5").update(query + mk, "utf8").digest("hex");
  return `${query}&w_rid=${wRid}`;
}

/**
 * 取当日 key 并附带登录态（带 Cookie 时 nav 会返回 isLogin，可用来判断凭据有没有过期）。
 * @returns {Promise<{imgKey:string, subKey:string, isLogin:boolean|null}>}
 */
export async function wbiKeys(request, { signal, cookie = "", force = false } = {}) {
  if (!force && keyCache.imgKey && Date.now() - keyCache.at < KEY_TTL_MS) {
    const logged = keyCache.isLogin;
    return { imgKey: keyCache.imgKey, subKey: keyCache.subKey, isLogin: logged };
  }
  const nav = await request(`${API}/x/web-interface/nav`, { signal, headers: cookie ? { Cookie: cookie } : {} });
  const { imgKey, subKey } = extractKeys(nav?.data?.wbi_img);
  if (!imgKey || !subKey) throw new Error(`nav 取 WBI key 失败 code=${nav?.code} ${nav?.message ?? ""}`);
  const isLogin = typeof nav?.data?.isLogin === "boolean" ? nav.data.isLogin : null;
  keyCache.at = Date.now();
  keyCache.imgKey = imgKey;
  keyCache.subKey = subKey;
  keyCache.isLogin = isLogin;
  return { imgKey, subKey, isLogin };
}

/** 测试用：把缓存清掉，免得用例之间互相影响。 */
export function resetKeyCache() {
  keyCache.at = 0;
  keyCache.imgKey = "";
  keyCache.subKey = "";
}
