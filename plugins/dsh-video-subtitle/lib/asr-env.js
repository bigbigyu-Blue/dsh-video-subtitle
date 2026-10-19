/**
 * 本机转写环境（faster-whisper）的安装位置、体检与一键安装。
 *
 * 为什么要这个文件：whisper 源要在本机跑 Python。以前的路径写死成 <DSH_HOME>/bili-duty/... 这种
 * 历史遗留目录，换台机器就找不到，用户也不可能自己去装。这里把「插件自己的正式安装位置」定下来，
 * 再给出体检和一键安装，装完直接能用。
 *
 * 正式位置（插件自己管，删掉这个目录就等于把转写环境整个卸掉）：
 *   <DSH_HOME>/video-subtitle/asr/venv/Scripts/python.exe   虚拟环境里的解释器
 *   <DSH_HOME>/video-subtitle/asr/hf-cache/hub/             模型缓存（HF_HOME 指到 hf-cache）
 *   <DSH_HOME>/video-subtitle/asr/tmp/                      转写时的临时文件
 *
 * 复用旧环境：老版本用的是 <DSH_HOME>/bili-duty/.venv-asr 和 <DSH_HOME>/bili-duty/.hf-cache，
 * 这两个目录同时存在、用户又没在配置里另指，就直接接着用，不逼人重装。用户自己配了 whisperPython
 * 或 whisperHfHome 也照样先听用户的。
 *
 * 安装任务全局只有一个，重复点安装拿到的是同一个任务号。安装日志一律脱敏，用户名、用户目录、
 * token 都不会露出来。
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/** 探针：确认解释器能跑，顺便打印版本。 */
const PY_VERSION_PROBE = "import sys;print(sys.version)";
/** 探针：确认 faster-whisper 装好了，顺便打印版本。 */
const PACKAGE_PROBE = "import faster_whisper,sys;print(faster_whisper.__version__)";
/** 国内装 Python 包用的镜像。 */
const PIP_MIRROR = ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"];
/** 国内下模型用的镜像。 */
const HF_MIRROR = "https://hf-mirror.com";
/** 装环境的四步，顺序固定。 */
const STEPS = [
  { id: "build-venv", label: "准备 Python 虚拟环境" },
  { id: "pip", label: "安装 faster-whisper" },
  { id: "model", label: "下载语音模型" },
  { id: "verify", label: "复查环境能不能用" },
];
const VENV_TIMEOUT = 10 * 60 * 1000;
const PIP_TIMEOUT = 30 * 60 * 1000;
const MODEL_TIMEOUT = 40 * 60 * 1000;
/** 日志最多留这么多行，防止装很久的机器把内存撑爆。 */
const LOG_LIMIT = 400;

/** DSH 的家目录：优先听环境变量，没有就用用户目录下的 .dsh。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/**
 * 算出一套路径。第二个参数 home 只给测试用，可以临时把「家目录」指到别处，
 * 免得测试去碰真实环境。
 *
 * 返回里的 reused 表示「用的是现成的环境，不是插件正式位置」：
 *   - 配置里写了 whisperPython 或 whisperHfHome：用配置值，reused 为真
 *   - 否则旧的 bili-duty 环境同时有解释器和模型缓存：用旧的，reused 为真
 *   - 都不满足：用正式位置，reused 为假
 */
export function asrPaths(cfg = {}, { home } = {}) {
  const base = home || dshHome();
  const root = path.join(base, "video-subtitle", "asr");
  const formalPython = path.join(root, "venv", "Scripts", "python.exe");
  const formalHfHome = path.join(root, "hf-cache");

  const legacyRoot = path.join(base, "bili-duty");
  const legacyPython = path.join(legacyRoot, ".venv-asr", "Scripts", "python.exe");
  const legacyHfHome = path.join(legacyRoot, ".hf-cache");

  const modelName = String(cfg.whisperModel || "small").trim() || "small";
  const configuredPython = String(cfg.whisperPython || "").trim();
  const configuredHfHome = String(cfg.whisperHfHome || "").trim();

  let python = formalPython;
  let hfHome = formalHfHome;
  let reused = false;
  // 临时目录必须跟着「实际要跑的那个解释器」走，不能一律指到插件正式位置：
  // 复用老环境时解释器在 bili-duty 那棵树里，只有那棵树对它放行写入，
  // 指到正式位置会直接 PermissionError，转写连开头都跑不起来。
  let tmpRoot = path.join(root, "tmp");

  if (configuredPython || configuredHfHome) {
    // 用户明确指了路，就按用户的来；只指一半时另一半用正式位置。
    python = configuredPython || formalPython;
    hfHome = configuredHfHome || formalHfHome;
    reused = true;
    tmpRoot = tmpNearPython(python);
  } else if (existsSync(legacyPython) && existsSync(path.join(legacyHfHome, "hub"))) {
    python = legacyPython;
    hfHome = legacyHfHome;
    reused = true;
    tmpRoot = path.join(legacyRoot, "tmp");
  }

  // 逐个备用：先试上面挑出来的那个，再试老环境旁边，最后才是插件正式位置。
  const tmpCandidates = [...new Set([tmpRoot, path.join(legacyRoot, "tmp"), path.join(root, "tmp")])];

  return {
    root,
    python,
    hfHome,
    hub: path.join(hfHome, "hub"),
    tmpRoot,
    tmpCandidates,
    modelName,
    reused,
  };
}

/**
 * 解释器旁边那个能写的临时目录。
 *
 * 标准虚拟环境是 <环境目录>/Scripts/python.exe，临时目录取 <环境目录的上一级>/tmp：
 * 老环境 bili-duty 正好就是 bili-duty/tmp，和它自己那棵树一起被放行写；正式位置则是 <root>/tmp。
 * 解释器不在 Scripts 下（比如直接指了个 python.exe）就退一步用它所在的目录下的 tmp。
 */
function tmpNearPython(python) {
  const dir = path.dirname(python);
  return path.basename(dir).toLowerCase() === "scripts" ? path.join(path.dirname(dir), "tmp") : path.join(dir, "tmp");
}

/** 模型目录可能有三种摆法，挨个认。 */
function modelDirs(p) {
  const name = "models--Systran--faster-whisper-" + p.modelName;
  return [
    path.join(p.hub, name), // 标准摆法：<hfHome>/hub/models--...
    path.join(p.hub, "hub", name), // 历史遗留：<hfHome>/hub/hub/models--...
    path.join(p.hfHome, name), // 有人把 hfHome 直接当缓存根
  ];
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function lastLine(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  return lines.length ? lines[lines.length - 1].trim() : "";
}

/** 跑一次命令，永远不抛异常：跑不起来也当成退出码 -1 返回。 */
async function safeRun(run, cmd, args, options = {}) {
  try {
    const r = await run(cmd, args, options);
    return {
      code: Number(r?.code ?? -1),
      stdout: String(r?.stdout ?? ""),
      stderr: String(r?.stderr ?? ""),
    };
  } catch (e) {
    return { code: -1, stdout: "", stderr: String(e?.message || e) };
  }
}

/**
 * 查环境：四步分别是解释器、依赖包、模型、临时目录。
 * 前三步全齐才叫 ready，临时目录缺了不影响（用的时候会自动建）。
 */
export async function asrStatus(cfg = {}, { home, run } = {}) {
  const p = asrPaths(cfg, { home });
  const doRun = typeof run === "function" ? run : defaultRun;
  const steps = [];

  // 第一步：Python 解释器在不在、能不能启动
  let pythonOk = false;
  let pythonDetail = "";
  if (!existsSync(p.python)) {
    pythonDetail = "找不到 Python 解释器：" + p.python + "，点一键安装会把它建好";
  } else {
    const r = await safeRun(doRun, p.python, ["-c", PY_VERSION_PROBE], { timeoutMs: 20000 });
    const ver = firstLine(r.stdout);
    if (r.code === 0 && ver) {
      pythonOk = true;
      pythonDetail = "Python 能跑，版本 " + ver;
    } else {
      pythonDetail = "Python 解释器在，但启动就报错：" + (lastLine(r.stderr) || "退出码 " + r.code) + "，这个环境得重装";
    }
  }
  steps.push({ id: "python", label: "Python 解释器", done: pythonOk, detail: pythonDetail });

  // 第二步：faster-whisper 这个包在不在
  let packageOk = false;
  let packageDetail = "";
  if (!pythonOk) {
    packageDetail = "还没有能用的 Python 解释器，先把它装好才能装 faster-whisper";
  } else {
    const r = await safeRun(doRun, p.python, ["-c", PACKAGE_PROBE], { timeoutMs: 60000 });
    const ver = firstLine(r.stdout);
    if (r.code === 0 && ver) {
      packageOk = true;
      packageDetail = "faster-whisper 已经装好，版本 " + ver;
    } else {
      packageDetail = "这个 Python 里没有能用的 faster-whisper：" + (lastLine(r.stderr) || "退出码 " + r.code) + "，点一键安装补上";
    }
  }
  steps.push({ id: "package", label: "transcribe 依赖（faster-whisper）", done: packageOk, detail: packageDetail });

  // 第三步：模型文件在不在
  const foundModel = modelDirs(p).find((dir) => existsSync(dir));
  steps.push({
    id: "model",
    label: "语音模型 " + p.modelName,
    done: Boolean(foundModel),
    detail: foundModel
      ? "模型已经下好，放在 " + foundModel
      : "还没下载模型 models--Systran--faster-whisper-" + p.modelName + "，应该在 " + p.hub + " 下面，点一键安装会拉下来",
  });

  // 第四步：临时目录（不阻塞，缺了会自动建）
  const tmpOk = existsSync(p.tmpRoot);
  steps.push({
    id: "tmp",
    label: "临时目录",
    done: tmpOk,
    detail: tmpOk ? "临时目录可以用：" + p.tmpRoot : "临时目录还不存在：" + p.tmpRoot + "，开始转写时会自动创建，不影响使用",
  });

  return {
    ready: pythonOk && packageOk && Boolean(foundModel),
    reused: p.reused,
    root: p.root,
    python: p.python,
    hfHome: p.hfHome,
    steps,
  };
}

/** 把话里的用户名、用户目录、token 抹掉。日志和报错一律先过这一道。 */
function redact(text) {
  let s = String(text ?? "");
  if (!s) return s;

  // 一、整段家目录（含产品侧环境变量写法）
  const homes = [os.homedir(), process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  for (const h of homes) s = s.split(h).join("<用户目录>");
  s = s.replace(/([A-Za-z]:\\Users\\)[^\\\r\n"'<>|]+/g, "$1<用户目录>");
  s = s.replace(/([A-Za-z]:\/Users\/)[^/\r\n"'<>|]+/g, "$1<用户目录>");

  // 二、单独出现的系统用户名
  let user = "";
  try {
    user = os.userInfo().username || "";
  } catch {
    user = process.env.USERNAME || "";
  }
  if (user && user.length >= 2) s = s.replace(new RegExp(user.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&"), "gi"), "<用户目录>");

  // 三、token / 密码一类的值
  s = s.replace(
    /\b(token|access_token|refresh_token|secret|password|passwd|pwd|api[_-]?key|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1$2<已隐藏>",
  );
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer <已隐藏>");
  s = s.replace(/\bhf_[A-Za-z0-9]{16,}\b/g, "<已隐藏>");
  return s;
}

/** 找个能用的系统 Python：先看提示，再看 py 启动器、PATH、常见安装位置。 */
async function findSystemPython({ run, hint, say }) {
  const tries = [];
  const add = (cmd, prefix, label) => {
    const key = cmd + " " + prefix.join(" ");
    if (!tries.some((t) => t.cmd + " " + t.prefix.join(" ") === key)) tries.push({ cmd, prefix, label });
  };
  const h = String(hint || "").trim();
  if (h) add(h, [], "配置里填的 " + h);
  add("py", ["-3"], "系统里的 py 启动器（py -3）");
  add("python", [], "PATH 里的 python");
  for (const exe of commonPythonPaths()) add(exe, [], exe);

  for (const t of tries) {
    const r = await safeRun(run, t.cmd, [...t.prefix, "-c", PY_VERSION_PROBE], { timeoutMs: 20000 });
    if (r.code === 0) return { ...t, version: firstLine(r.stdout) || "版本未知" };
    say("试 " + t.label + "：不能用（" + (lastLine(r.stderr) || "退出码 " + r.code) + "）");
  }
  return null;
}

/** Python 常见的默认安装位置。找不到也不报错，只是没这个候选。 */
function commonPythonPaths() {
  const out = [];
  const bases = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python") : "",
    process.env.ProgramFiles || "",
    process.env["ProgramFiles(x86)"] || "",
  ].filter(Boolean);
  for (const base of bases) {
    let names = [];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^python3/i.test(name)) continue;
      out.push(path.join(base, name, "python.exe"));
    }
  }
  const drive = path.parse(os.homedir()).root;
  if (drive) {
    try {
      for (const name of readdirSync(drive)) {
        if (!/^python3/i.test(name)) continue;
        out.push(path.join(drive, name, "python.exe"));
      }
    } catch {
      /* 盘符根目录读不了就算了 */
    }
  }
  return out;
}

/** 正在跑的子进程，取消时挨个掐掉。 */
const liveChildren = new Set();

function killTree(child) {
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    /* 已经退出了 */
  }
  if (process.platform === "win32" && child.pid) {
    // pip 会再开一堆子进程，光杀父进程有时候留尾巴，叫上 taskkill 一起清。
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {});
    } catch {
      /* 没有 taskkill 就算了 */
    }
  }
}

/**
 * 内置的命令执行：能拿到逐行输出、能设超时、能被打断。
 * 约定跟外部注入的 run 一样：永远返回 { code, stdout, stderr }，不抛异常。
 */
function defaultRun(cmd, args, { cwd, env, timeoutMs = 0, onLine } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const buffers = { stdout: "", stderr: "" };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: "启动失败：" + (e?.message || e) });
      return;
    }
    liveChildren.add(child);

    const flush = (stream) => {
      const line = buffers[stream].replace(/\r$/, "");
      buffers[stream] = "";
      if (line.trim()) {
        try {
          onLine?.(line, stream);
        } catch {
          /* 外部回调出错不影响命令本身 */
        }
      }
    };
    const feed = (chunk, stream) => {
      const text = chunk.toString();
      buffers[stream] += text;
      if (buffers[stream].length > 200000) buffers[stream] = buffers[stream].slice(-100000);
      let idx = buffers[stream].indexOf("\n");
      while (idx >= 0) {
        const line = buffers[stream].slice(0, idx).replace(/\r$/, "");
        buffers[stream] = buffers[stream].slice(idx + 1);
        if (line.trim()) {
          try {
            onLine?.(line, stream);
          } catch {
            /* 同上 */
          }
        }
        idx = buffers[stream].indexOf("\n");
      }
    };

    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      liveChildren.delete(child);
      flush("stdout");
      flush("stderr");
      if (extra) stderr = (stderr + "\n" + extra).trim();
      resolve({ code, stdout, stderr });
    };

    child.stdout?.on("data", (d) => {
      if (stdout.length < 200000) stdout += String(d);
      feed(d, "stdout");
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < 200000) stderr += String(d);
      feed(d, "stderr");
    });
    child.on("error", (e) => finish(-1, "启动失败：" + (e?.message || e)));
    child.on("close", (code) => finish(typeof code === "number" ? code : -1));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        finish(-1, "这条命令超过 " + Math.round(timeoutMs / 1000) + " 秒还没结束，已经强制停下");
      }, timeoutMs);
    }
  });
}

/** 全局唯一的安装任务状态。 */
let state = blankState();
/** 当前这次任务的日志出口（外部传进来的 log 回调）。 */
let logSink = null;
/** 任务号自增，避免同一毫秒内两次启动撞号。 */
let taskSeq = 0;
/** 当前这个任务有没有人点了取消。每次开新任务都会清掉。 */
let taskCancelled = false;

function blankState() {
  return {
    taskId: null,
    running: false,
    ok: null,
    currentStep: null,
    steps: STEPS.map((s) => ({ id: s.id, label: s.label, state: "pending", detail: "还没开始" })),
    log: [],
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

/** 把一行写进任务日志：先脱敏，再截长度。 */
function pushLog(line) {
  const text = redact(line);
  state.log.push(text);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  try {
    logSink?.(text);
  } catch {
    /* 外部日志回调出错不影响安装 */
  }
}

/** 看一眼当前安装任务。返回的是副本，外面改不到内部状态。 */
export function setupState() {
  return {
    ...state,
    steps: state.steps.map((s) => ({ ...s })),
    log: state.log.slice(),
  };
}

/** 停掉正在跑的安装。没任务在跑就返回 cancelled:false。 */
export function cancelSetup() {
  if (!state.running) return { cancelled: false };
  taskCancelled = true;
  for (const child of liveChildren) killTree(child);
  const running = state.steps.find((s) => s.state === "running");
  if (running) {
    running.state = "failed";
    running.detail = "已取消";
  }
  state.running = false;
  state.ok = false;
  state.currentStep = null;
  state.finishedAt = Date.now();
  state.error = "安装已取消";
  pushLog("安装已取消，已经停下的东西不会再动");
  return { cancelled: true };
}

/**
 * 开始一键安装。立刻返回任务号，真正干活在后台跑，进度看 setupState()。
 * 已经有一个在跑就返回现有的任务号（started 为 false）。
 */
export async function startSetup(cfg = {}, { run, log, pythonHint, home } = {}) {
  if (state.running && state.taskId) return { started: false, taskId: state.taskId };

  taskSeq += 1;
  const taskId = "asr-setup-" + Date.now().toString(36) + "-" + taskSeq;
  taskCancelled = false;
  logSink = typeof log === "function" ? log : null;
  state = blankState();
  state.taskId = taskId;
  state.running = true;
  state.startedAt = Date.now();
  state.currentStep = STEPS[0].id;

  const options = {
    run: typeof run === "function" ? run : defaultRun,
    // 提示的 Python 路径两头都认：单独传的 pythonHint 优先，其次配置里写的 pythonHint
    pythonHint: pythonHint || cfg?.pythonHint,
    home,
  };
  // 后台跑，不占着调用方；万一整段代码炸了也别让状态永远挂着「正在跑」。
  runSetup(taskId, cfg && typeof cfg === "object" ? cfg : {}, options).catch((e) => {
    if (state.taskId !== taskId || !state.running) return;
    state.running = false;
    state.ok = false;
    state.finishedAt = Date.now();
    state.currentStep = null;
    state.error = redact(e?.message || String(e));
    pushLog("安装过程出了意外：" + state.error);
  });
  return { started: true, taskId };
}

async function runSetup(taskId, cfg, options) {
  const run = options.run;
  const paths = asrPaths(cfg, { home: options.home });
  // 取消是按任务记的：点取消那一刻已经换过任务号，这里必须拿启动时那一份，
  // 不能读全局的，否则会被下一轮任务误带成「没取消」。
  const alive = () => state.taskId === taskId && !taskCancelled;
  const say = (line) => {
    if (state.taskId === taskId) pushLog(line);
  };
  const stepOf = (id) => state.steps.find((s) => s.id === id);
  const tailOf = (r) => String(r.stderr || "").split(/\r?\n/).filter((line) => line.trim()).slice(-8);
  const reasonOf = (r) => lastLine(r.stderr) || lastLine(r.stdout) || "没有输出";

  /** 跑一条命令，失败就把错误输出末尾几行写进日志，然后抛中文错误。 */
  const exec = async (cmd, args, { cwd, env, timeoutMs, label } = {}) => {
    const r = await safeRun(run, cmd, args, {
      cwd,
      env,
      timeoutMs,
      onLine: (line, stream) => say((stream === "stderr" ? "  ! " : "  > ") + line),
    });
    if (r.code === 0) return r;
    const tail = tailOf(r);
    if (tail.length) {
      say("  ! " + (label || "命令") + " 的错误输出末尾：");
      for (const line of tail) say("  ! " + line);
    }
    throw new Error((label || "命令") + "没成功（退出码 " + r.code + "）：" + reasonOf(r));
  };

  /** 跑一步：成功标 done，失败标 failed 并把整个任务收掉。 */
  const runStep = async (id, fn) => {
    if (!alive()) return false;
    const s = stepOf(id);
    state.currentStep = id;
    s.state = "running";
    s.detail = "正在做";
    say("【" + s.label + "】开始");
    try {
      await fn(s);
    } catch (e) {
      if (!alive()) {
        s.state = "failed";
        s.detail = "已取消";
        throw e;
      }
      const reason = redact(e?.message || String(e));
      s.state = "failed";
      s.detail = reason;
      state.running = false;
      state.currentStep = null;
      state.ok = false;
      state.error = reason;
      state.finishedAt = Date.now();
      say("【" + s.label + "】失败：" + reason);
      throw e;
    }
    s.state = "done";
    say("【" + s.label + "】完成");
    return true;
  };

  try {
    // 复用现成环境：先体检。能用就一步都不动，不能用就如实说清楚，别假装装好了。
    if (paths.reused) {
      say("现在用的是现成的环境（" + paths.python + "，模型缓存在 " + paths.hfHome + "）");
      const st = await asrStatus(cfg, { home: options.home, run });
      if (st.ready) {
        for (const s of state.steps) {
          s.state = "done";
          s.detail = "现成的环境已经能用，这次没有改动它";
        }
        state.running = false;
        state.ok = true;
        state.currentStep = null;
        state.finishedAt = Date.now();
        say("现成的环境检查通过，不用重新装");
        return;
      }
      const bad = st.steps.slice(0, 3).filter((s) => !s.done);
      const why =
        "现在复用的是 " + st.python + "，但它还不完整：" + bad.map((s) => s.label + "——" + s.detail).join("；");
      const first = stepOf(STEPS[0].id);
      first.state = "failed";
      first.detail = redact(why);
      state.running = false;
      state.currentStep = null;
      state.ok = false;
      state.error = redact(why);
      state.finishedAt = Date.now();
      say("【" + first.label + "】失败：" + state.error);
      return;
    }

    // 第一步：建虚拟环境
    await runStep("build-venv", async (s) => {
      const found = await findSystemPython({ run, hint: options.pythonHint, say });
      if (!found) {
        throw new Error(
          "这台机器上没找到能用的 Python：先去 python.org 装一个 3.10 以上的版本，装的时候勾上把它加到 PATH，回来再点一次一键安装",
        );
      }
      say("用 " + found.label + " 来建虚拟环境（" + found.version + "）");
      const venvDir = path.join(paths.root, "venv");
      await exec(found.cmd, [...found.prefix, "-m", "venv", venvDir], {
        timeoutMs: VENV_TIMEOUT,
        label: "创建虚拟环境",
      });
      if (!existsSync(paths.python)) {
        throw new Error("虚拟环境建完了，但没看到解释器 " + paths.python + "，多半是 Python 自带的 venv 组件缺了，重装 Python 时勾上它");
      }
      try {
        await fs.mkdir(paths.tmpRoot, { recursive: true });
      } catch {
        /* 临时目录建不出来不算安装失败，转写时会再试 */
      }
      s.detail = "虚拟环境在 " + venvDir;
    });

    // 第二步：装 faster-whisper（先走国内镜像，不行再回官方源）
    await runStep("pip", async (s) => {
      const python = paths.python;
      const up = await safeRun(run, python, ["-m", "pip", "install", "--upgrade", "pip", ...PIP_MIRROR], {
        timeoutMs: PIP_TIMEOUT,
        onLine: (line, stream) => say((stream === "stderr" ? "  ! " : "  > ") + line),
      });
      if (up.code !== 0) {
        say("pip 自身升级没成功，不耽误正事，用现有的 pip 继续装");
      }
      say("装 faster-whisper：先走清华镜像");
      let r = await safeRun(run, python, ["-m", "pip", "install", "--upgrade", "faster-whisper", ...PIP_MIRROR], {
        timeoutMs: PIP_TIMEOUT,
        onLine: (line, stream) => say((stream === "stderr" ? "  ! " : "  > ") + line),
      });
      if (r.code !== 0) {
        say("清华镜像没装上，换回官方源再试一次");
        r = await safeRun(run, python, ["-m", "pip", "install", "--upgrade", "faster-whisper"], {
          timeoutMs: PIP_TIMEOUT,
          onLine: (line, stream) => say((stream === "stderr" ? "  ! " : "  > ") + line),
        });
      }
      if (r.code !== 0) {
        const tail = tailOf(r);
        if (tail.length) {
          say("  ! 安装 faster-whisper 的错误输出末尾：");
          for (const line of tail) say("  ! " + line);
        }
        throw new Error("faster-whisper 装不上（退出码 " + r.code + "）：" + reasonOf(r) + "；检查一下网络或者换一台能连 PyPI 的机器");
      }
      s.detail = "faster-whisper 已经装进虚拟环境";
    });

    // 第三步：下模型（走国内镜像）
    await runStep("model", async (s) => {
      const script = [
        "import sys",
        "from huggingface_hub import snapshot_download",
        'print(snapshot_download("Systran/faster-whisper-" + sys.argv[1]))',
      ].join("\n");
      say("下载语音模型 " + paths.modelName + " 到 " + paths.hfHome + "（走 " + HF_MIRROR + " 镜像）");
      await exec(paths.python, ["-c", script, paths.modelName], {
        env: { HF_HOME: paths.hfHome, HF_ENDPOINT: HF_MIRROR, HF_HUB_DISABLE_XET: "1" },
        timeoutMs: MODEL_TIMEOUT,
        label: "下载语音模型",
      });
      const dir = modelDirs(paths).find((d) => existsSync(d));
      if (!dir) {
        throw new Error(
          "模型下载命令跑完了，但在 " + paths.hub + " 下面没看到 models--Systran--faster-whisper-" + paths.modelName + " 目录，可能是网络断了或者镜像地址没生效",
        );
      }
      s.detail = "模型放在 " + dir;
    });

    // 第四步：复查
    await runStep("verify", async (s) => {
      const st = await asrStatus(cfg, { home: options.home, run });
      const bad = st.steps.slice(0, 3).filter((x) => !x.done);
      if (bad.length) {
        throw new Error("复查没通过：" + bad.map((x) => x.label + "——" + x.detail).join("；"));
      }
      s.detail = "解释器、依赖包、模型三样都齐了，可以开始转写";
    });

    state.running = false;
    state.ok = true;
    state.currentStep = null;
    state.finishedAt = Date.now();
    say("整套转写环境装好了，可以用了");
  } catch (e) {
    if (taskCancelled) {
      if (state.taskId === taskId && state.running) {
        state.running = false;
        state.ok = false;
        state.finishedAt = Date.now();
        state.currentStep = null;
        if (!state.error) state.error = "安装已取消";
      }
      return;
    }
    if (state.taskId === taskId && state.running) {
      state.running = false;
      state.ok = false;
      state.currentStep = null;
      state.finishedAt = Date.now();
      state.error = redact(e?.message || String(e));
      say("安装失败：" + state.error);
    }
  }
}

/** 给愿意自己动手的人看的说明。里面的路径已经脱敏，不会有用户名。 */
export function installHint(cfg = {}) {
  const p = asrPaths(cfg);
  const lines = [
    "本机转写要装这些东西，愿意自己动手就照下面来：",
    "",
    "1. 先装 Python 3.10 或更新的版本，安装时勾上「Add Python to PATH」（把 Python 加到 PATH）。",
    "   已经装过就跳过这步，用 py -3 或者 python 都能验证一下。",
    "",
    "2. 建一个专门给插件用的虚拟环境（在命令提示符里执行）：",
    '   py -3 -m venv "' + p.root + '\\venv"',
    "   机器上没有 py 启动器的话，把 py -3 换成 python 或者 python.exe 的完整路径。",
    "",
    "3. 装转写引擎。国内网络建议带上清华镜像，装不上再换成官方源：",
    '   "' + p.python + '" -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple',
    '   "' + p.python + '" -m pip install --upgrade faster-whisper -i https://pypi.tuna.tsinghua.edu.cn/simple',
    "",
    "4. 下载语音模型。下载前先把这三个环境变量设好，否则国内多半下不动：",
    "   set HF_ENDPOINT=" + HF_MIRROR,
    "   set HF_HUB_DISABLE_XET=1",
    "   set HF_HOME=" + p.hfHome,
    '   "' + p.python + '" -c "from huggingface_hub import snapshot_download; print(snapshot_download(\'Systran/faster-whisper-' + p.modelName + '\'))"',
    "   HF_ENDPOINT 指定国内镜像站；HF_HUB_DISABLE_XET=1 关掉新版传输方式，老版本库不认它也不会报错；",
    "   HF_HOME 决定模型缓存落到哪里，必须跟插件用的是同一个目录。",
    "",
    "5. 弄完回到设置页点「检查环境」，四项都打勾就能开始转写。转写本身不需要联网。",
    "",
    "插件认这三个配置项（写在插件配置里，都是可选的）：",
    "   whisperPython：Python 解释器的完整路径，默认就是上面那个虚拟环境里的 python.exe",
    "   whisperHfHome：模型缓存目录，默认是上面那个 hf-cache 目录",
    "   whisperModel：用哪个模型，默认 small；机器够快可以换 medium 或 large-v3，想快就换 base 或 tiny",
    "",
    "插件自己的安装位置是 " + p.root + "，把整个目录删掉就等于把转写环境卸载干净。",
  ];
  return redact(lines.join("\n"));
}
