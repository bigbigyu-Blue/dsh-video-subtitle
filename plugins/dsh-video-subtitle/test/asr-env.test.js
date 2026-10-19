import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  dshHome,
  asrPaths,
  asrStatus,
  startSetup,
  setupState,
  cancelSetup,
  installHint,
} from "../lib/asr-env.js";

// 所有临时目录都开在仓库里面的 test 目录下，不走系统临时目录，收尾整个删掉。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_BASE = path.join(HERE, ".tmp-asr-env-" + process.pid);
let tmpSeq = 0;

function tmpDir(name) {
  tmpSeq += 1;
  const dir = path.join(TMP_BASE, name + "-" + tmpSeq);
  mkdirSync(dir, { recursive: true });
  return dir;
}

after(async () => {
  await fs.rm(TMP_BASE, { recursive: true, force: true });
});

const VERSION_SCRIPT = "import sys;print(sys.version)";
const PACKAGE_SCRIPT = "import faster_whisper,sys;print(faster_whisper.__version__)";
const hasChinese = (s) => /[\u4e00-\u9fa5]/.test(String(s || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等后台安装任务跑完；超时就断言失败，不许一直挂着。 */
async function waitIdle(timeoutMs = 8000) {
  const t0 = Date.now();
  while (setupState().running) {
    if (Date.now() - t0 > timeoutMs) throw new Error("后台安装任务一直没结束");
    await sleep(10);
  }
  return setupState();
}

/**
 * 假 run：不真的跑 pip、不真的联网，只在临时目录里造出该有的东西。
 * failOn 指定在哪一步失败：venv / pip / model。
 */
function makeFakeRun({ home, pythonOk = true, packageOk = true, failOn = "", slowMs = 0, chatty = false } = {}) {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    const argv = args.map(String);
    const script = argv.includes("-c") ? argv[argv.indexOf("-c") + 1] : "";
    calls.push({ cmd, argv, env: opts.env, script });
    const line = (text, stream = "stdout") => opts.onLine?.(text, stream);
    if (slowMs > 0) await sleep(slowMs);

    if (chatty) {
      line("正在处理 C:\\Users\\zhangsan\\AppData\\Local\\x 这个目录");
      line("下载地址里带了 token=abcdef123，不该出现在日志里");
    }

    // 解释器探针
    if (script === VERSION_SCRIPT) {
      return pythonOk
        ? { code: 0, stdout: "3.12.10 (main, Oct  1 2025)\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "不是个能用的解释器" };
    }
    // 依赖包探针
    if (script === PACKAGE_SCRIPT) {
      return packageOk
        ? { code: 0, stdout: "1.2.1\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "No module named 'faster_whisper'" };
    }
    // 建虚拟环境
    if (argv.includes("venv")) {
      if (failOn === "venv") return { code: 1, stdout: "", stderr: "venv 建不起来" };
      const dir = argv[argv.length - 1];
      mkdirSync(path.join(dir, "Scripts"), { recursive: true });
      writeFileSync(path.join(dir, "Scripts", "python.exe"), "");
      return { code: 0, stdout: "建好了", stderr: "" };
    }
    // pip
    if (argv.includes("pip") && argv.includes("install")) {
      if (failOn === "pip") return { code: 1, stdout: "", stderr: "ERROR: 连不上镜像站" };
      if (argv.includes("faster-whisper")) line("Successfully installed faster-whisper-1.2.1");
      return { code: 0, stdout: "装好了", stderr: "" };
    }
    // 下模型
    if (script.includes("snapshot_download")) {
      if (failOn === "model") return { code: 1, stdout: "", stderr: "ConnectionError: 下载失败" };
      const model = argv[argv.length - 1];
      const dir = path.join(home, "video-subtitle", "asr", "hf-cache", "hub", "models--Systran--faster-whisper-" + model);
      mkdirSync(dir, { recursive: true });
      return { code: 0, stdout: dir + "\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "假 run 不认识的命令：" + cmd + " " + argv.join(" ") };
  };
  run.calls = calls;
  return run;
}

test("dshHome 听环境变量，没有就用用户目录下的 .dsh", () => {
  const old = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(TMP_BASE, "home-x");
    assert.equal(dshHome(), path.join(TMP_BASE, "home-x"));
    delete process.env.DSH_HOME;
    assert.equal(dshHome(), path.join(os.homedir(), ".dsh"));
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
  }
});

test("asrPaths：配置里明确写了就用配置值，并标成复用", () => {
  const home = tmpDir("cfg");
  const p = asrPaths({ whisperPython: "D:\\自己装的\\python.exe", whisperHfHome: "D:\\自己装的\\cache" }, { home });
  assert.equal(p.reused, true);
  assert.equal(p.python, "D:\\自己装的\\python.exe");
  assert.equal(p.hfHome, "D:\\自己装的\\cache");
  assert.equal(p.hub, path.join("D:\\自己装的\\cache", "hub"));
  assert.equal(p.root, path.join(home, "video-subtitle", "asr"));
  assert.equal(p.modelName, "small");
});

test("asrPaths：老环境还在就接着用，不逼人重装", () => {
  const home = tmpDir("legacy");
  const legacyPython = path.join(home, "bili-duty", ".venv-asr", "Scripts", "python.exe");
  const legacyHub = path.join(home, "bili-duty", ".hf-cache", "hub");
  mkdirSync(path.dirname(legacyPython), { recursive: true });
  writeFileSync(legacyPython, "");
  mkdirSync(legacyHub, { recursive: true });

  const p = asrPaths({}, { home });
  assert.equal(p.reused, true);
  assert.equal(p.python, legacyPython);
  assert.equal(p.hfHome, path.join(home, "bili-duty", ".hf-cache"));
});

test("asrPaths：什么都没有就用插件自己的正式位置", () => {
  const home = tmpDir("empty");
  const p = asrPaths({}, { home });
  assert.equal(p.reused, false);
  assert.equal(p.root, path.join(home, "video-subtitle", "asr"));
  assert.equal(p.python, path.join(home, "video-subtitle", "asr", "venv", "Scripts", "python.exe"));
  assert.equal(p.hfHome, path.join(home, "video-subtitle", "asr", "hf-cache"));
  assert.equal(p.hub, path.join(home, "video-subtitle", "asr", "hf-cache", "hub"));
  assert.equal(p.tmpRoot, path.join(home, "video-subtitle", "asr", "tmp"));
});

test("asrStatus：空目录就是不能用，缺什么用中文说清楚", async () => {
  const home = tmpDir("status-empty");
  // 这个假 run 一次都不该被调用：解释器根本不存在
  const run = async () => {
    throw new Error("空目录不该跑任何命令");
  };
  const st = await asrStatus({}, { home, run });
  assert.equal(st.ready, false);
  assert.equal(st.steps.length, 4);
  assert.deepEqual(st.steps.map((s) => s.id), ["python", "package", "model", "tmp"]);
  assert.equal(st.steps[0].done, false);
  assert.equal(st.steps[2].done, false);
  for (const s of st.steps) {
    assert.ok(hasChinese(s.detail), "每一步的说明都该是中文：" + s.id + " -> " + s.detail);
  }
  assert.match(st.steps[0].detail, /找不到/);
  assert.match(st.steps[2].detail, /还没下载/);
});

test("asrStatus：两种模型目录摆法都认", async () => {
  const home = tmpDir("status-model-a");
  const py = path.join(home, "video-subtitle", "asr", "venv", "Scripts", "python.exe");
  mkdirSync(path.dirname(py), { recursive: true });
  writeFileSync(py, "");
  mkdirSync(path.join(home, "video-subtitle", "asr", "hf-cache", "hub", "models--Systran--faster-whisper-small"), {
    recursive: true,
  });

  const run = async (cmd, args) => {
    const script = args[args.indexOf("-c") + 1];
    if (script === VERSION_SCRIPT) return { code: 0, stdout: "3.12.10\n", stderr: "" };
    if (script === PACKAGE_SCRIPT) return { code: 0, stdout: "1.2.1\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "不认识" };
  };
  const st = await asrStatus({}, { home, run });
  assert.equal(st.ready, true);
  assert.equal(st.steps[2].done, true);

  // 再试历史那种多套一层的摆法：hub/hub/models--...
  const home2 = tmpDir("status-model-b");
  const py2 = path.join(home2, "video-subtitle", "asr", "venv", "Scripts", "python.exe");
  mkdirSync(path.dirname(py2), { recursive: true });
  writeFileSync(py2, "");
  mkdirSync(
    path.join(home2, "video-subtitle", "asr", "hf-cache", "hub", "hub", "models--Systran--faster-whisper-small"),
    { recursive: true },
  );
  const st2 = await asrStatus({}, { home: home2, run });
  assert.equal(st2.steps[2].done, true);
});

test("一键安装：四步全跑完，状态变成能用，日志有内容", async () => {
  const home = tmpDir("setup-ok");
  const run = makeFakeRun({ home });
  const started = await startSetup({}, { run, home });
  assert.equal(started.started, true);
  assert.ok(started.taskId);

  const st = await waitIdle();
  assert.equal(st.ok, true);
  assert.equal(st.error, null);
  assert.deepEqual(st.steps.map((s) => s.state), ["done", "done", "done", "done"]);
  assert.ok(st.log.length > 0, "日志不该是空的");
  assert.ok(st.log.some((l) => l.includes("faster-whisper")), "日志里该看到装了什么东西");
  assert.ok(st.finishedAt >= st.startedAt);
  assert.equal(st.currentStep, null);

  // 装完真的能体检通过
  const status = await asrStatus({}, { home, run });
  assert.equal(status.ready, true);
});

test("一键安装：中途失败就停下，后续步骤保持没开始", async () => {
  const home = tmpDir("setup-fail");
  const run = makeFakeRun({ home, failOn: "pip" });
  await startSetup({}, { run, home });
  const st = await waitIdle();

  assert.equal(st.running, false);
  assert.equal(st.ok, false);
  assert.ok(hasChinese(st.error), "错误原因必须是中文：" + st.error);
  assert.match(st.error, /faster-whisper/);
  const byId = Object.fromEntries(st.steps.map((s) => [s.id, s]));
  assert.equal(byId["build-venv"].state, "done");
  assert.equal(byId.pip.state, "failed");
  assert.equal(byId.model.state, "pending");
  assert.equal(byId.verify.state, "pending");
  assert.ok(st.log.some((l) => /错误输出末尾/.test(l)), "失败该把错误输出末尾几行写进日志");
});

test("一键安装：同一时间只允许一个任务", async () => {
  const home = tmpDir("setup-one");
  const run = makeFakeRun({ home, slowMs: 30 });
  const p1 = startSetup({}, { run, home });
  const p2 = startSetup({}, { run, home });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.started, true);
  assert.equal(r2.started, false);
  assert.equal(r2.taskId, r1.taskId);
  await waitIdle();
  assert.equal(setupState().ok, true);
});

test("一键安装：日志会把用户名和 token 抹掉", async () => {
  const home = tmpDir("setup-redact");
  const run = makeFakeRun({ home, chatty: true });
  await startSetup({}, { run, home });
  const st = await waitIdle();
  const log = st.log.join("\n");
  assert.ok(log.length > 0);
  assert.ok(!log.includes("zhangsan"), "日志里不该出现用户名：" + log);
  assert.ok(!log.includes("abcdef"), "日志里不该出现 token 的值：" + log);
  assert.ok(log.includes("<用户目录>"), "用户目录该被替换成占位符");
});

test("现成环境已经能用：一步都不动，直接标成完成", async () => {
  const home = tmpDir("reuse-ok");
  const legacyPython = path.join(home, "bili-duty", ".venv-asr", "Scripts", "python.exe");
  mkdirSync(path.dirname(legacyPython), { recursive: true });
  writeFileSync(legacyPython, "");
  mkdirSync(path.join(home, "bili-duty", ".hf-cache", "hub", "models--Systran--faster-whisper-small"), {
    recursive: true,
  });

  const run = makeFakeRun({ home });
  await startSetup({}, { run, home });
  const st = await waitIdle();

  assert.equal(st.ok, true);
  assert.deepEqual(st.steps.map((s) => s.state), ["done", "done", "done", "done"]);
  // 只该跑两个探针，不该建环境、不该装包、不该下模型
  assert.equal(run.calls.filter((c) => c.argv.includes("venv")).length, 0);
  assert.equal(run.calls.filter((c) => c.argv.includes("install")).length, 0);
  assert.equal(run.calls.filter((c) => c.script.includes("snapshot_download")).length, 0);
});

test("现成环境其实不完整：老实报错，不假装装好了", async () => {
  const home = tmpDir("reuse-bad");
  const legacyPython = path.join(home, "bili-duty", ".venv-asr", "Scripts", "python.exe");
  mkdirSync(path.dirname(legacyPython), { recursive: true });
  writeFileSync(legacyPython, "");
  mkdirSync(path.join(home, "bili-duty", ".hf-cache", "hub"), { recursive: true });

  const run = makeFakeRun({ home, packageOk: false });
  await startSetup({}, { run, home });
  const st = await waitIdle();

  assert.equal(st.ok, false);
  assert.equal(st.running, false);
  assert.ok(hasChinese(st.error));
  assert.match(st.error, /faster-whisper/);
  assert.equal(st.steps[0].state, "failed");
});

test("取消安装：没任务时说没有，有任务时能停", async () => {
  assert.deepEqual(cancelSetup(), { cancelled: false });

  const home = tmpDir("setup-cancel");
  // 这个假 run 一直不返回，模拟卡在下载里
  const run = async () => new Promise(() => {});
  await startSetup({}, { run, home });
  assert.equal(setupState().running, true);
  const r = cancelSetup();
  assert.equal(r.cancelled, true);
  const st = setupState();
  assert.equal(st.running, false);
  assert.equal(st.ok, false);
  assert.ok(hasChinese(st.error));
});

test("手动安装说明：该说的都在，而且不泄露用户名", () => {
  const text = installHint({});
  assert.ok(hasChinese(text));
  assert.match(text, /https:\/\/hf-mirror\.com/);
  assert.match(text, /faster-whisper/);
  assert.match(text, /HF_HOME/);
  assert.ok(!text.includes(os.homedir()), "说明里不该出现真的家目录");
  let user = "";
  try {
    user = os.userInfo().username || "";
  } catch {
    user = process.env.USERNAME || "";
  }
  if (user && user.length >= 3) {
    assert.ok(!text.toLowerCase().includes(user.toLowerCase()), "说明里不该出现系统用户名");
  }
});
