/**
 * 用户设置：给界面用的一份小配置，存在 <DSH_HOME>/video-subtitle/settings.json。
 *
 * 为什么要有它：插件默认配置写在 cordis.patch.yml 里，那份 YAML 是给命令行用户看的，
 * 普通用户不可能去改。界面上勾的东西写进这个 JSON，读的时候盖在插件配置上面，
 * 优先级是「界面里改过的 > 插件配置 > 代码里的默认值」。
 *
 * 这个文件里不放凭据：登录凭据在 bili-login.js 管的另一个文件里。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 界面能改的字段，以及各自的类型。没列在这里的字段界面不能写。 */
const SCHEMA = {
  preferLang: { type: "string", values: ["zh", "en", "auto"], label: "要哪种语言的字幕" },
  saveToWorkspace: { type: "boolean", label: "存到当前工作区" },
  workspaceSubdir: { type: "string", label: "工作区里的子目录" },
  saveDir: { type: "string", label: "固定保存目录" },
  cacheTtlDays: { type: "number", min: 0, max: 365, label: "缓存保留天数" },
  fullCoveragePct: { type: "number", min: 10, max: 100, label: "完整度门槛（百分比）" },
  whisperModel: { type: "string", values: ["tiny", "base", "small", "medium"], label: "转写模型" },
  whisperBatchSize: { type: "number", min: 0, max: 32, label: "批处理条数" },
};

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function settingsFile() {
  return path.join(dshHome(), "video-subtitle", "settings.json");
}

/** 只保留界面允许、且类型对得上的字段。 */
function clean(patch) {
  const out = {};
  for (const [k, def] of Object.entries(SCHEMA)) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const v = patch[k];
    if (v === null || v === undefined) continue;
    if (def.type === "boolean") {
      out[k] = Boolean(v);
    } else if (def.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Math.min(def.max, Math.max(def.min, Math.trunc(n)));
    } else {
      const s = String(v).trim();
      if (!s) continue;
      if (def.values && !def.values.includes(s)) continue;
      out[k] = s;
    }
  }
  return out;
}

/** 读已经存下的设置，文件不在或坏了就当没设置过。 */
export function loadSettings({ file } = {}) {
  const target = file || settingsFile();
  if (!existsSync(target)) return {};
  try {
    return clean(JSON.parse(readFileSync(target, "utf8")));
  } catch {
    return {};
  }
}

/** 存设置：传进来的字段合并进已有的，传 null 表示删掉这个字段。写完返回新设置。 */
export function saveSettings(patch, { file } = {}) {
  const target = file || settingsFile();
  const current = loadSettings({ file: target });
  const next = { ...current };
  for (const key of Object.keys(SCHEMA)) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (patch[key] === null) delete next[key];
  }
  Object.assign(next, clean(patch));
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
  return next;
}

/**
 * 把界面设置盖到插件配置上，得到真正生效的配置。
 * 每次都重新读盘，所以界面上改完立刻生效，不用重启。
 */
export function effectiveConfig(cfg = {}, { file } = {}) {
  const stored = loadSettings({ file });
  const merged = { ...cfg, ...stored };
  // 界面上把语种存成一个值，插件内部要的是「按优先级排的数组」，这里做一次换算
  if (typeof stored.preferLang === "string") {
    merged.preferLang = stored.preferLang === "auto" ? ["zh", "en"] : [stored.preferLang];
  }
  // 有界面设置时，保存位置相关的组合要跟着一起变，不然会出现「说存工作区、实际存到固定目录」。
  if (Object.prototype.hasOwnProperty.call(stored, "saveToWorkspace") && stored.saveToWorkspace) {
    merged.saveDir = "";
  }
  return merged;
}

/** 给界面用的字段说明（带当前值），界面不用自己维护一份。 */
export function describeSettings(cfg = {}, { file } = {}) {
  const stored = loadSettings({ file });
  const merged = effectiveConfig(cfg, { file });
  return Object.entries(SCHEMA).map(([key, def]) => ({
    key,
    type: def.type,
    label: def.label,
    values: def.values ?? null,
    min: def.min ?? null,
    max: def.max ?? null,
    overridden: Object.prototype.hasOwnProperty.call(stored, key),
    value: key === "preferLang" && Array.isArray(merged.preferLang) ? (stored.preferLang ?? "auto") : (merged[key] ?? null),
  }));
}

export { SCHEMA as SETTINGS_SCHEMA };
