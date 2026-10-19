/**
 * 界面这一半：在「设置」里加一个「视频字幕」页面。
 *
 * 普通用户不该去翻配置文件，更不该自己去浏览器里抠 Cookie。这个页面做三件事：
 *   1. 点一下出二维码，手机 B站 扫一下就登录好了；
 *   2. 本机转写环境缺什么，一键装；
 *   3. 常用的几项设置直接在这里改，改完立刻生效。
 *
 * 这是一个手写的客户端模块，不经过打包工具。工厂函数里只能同步拿到宿主预置的 react，
 * 其它一律走 fetch("/api/video-subtitle/...") 问服务端要。
 */
window.__ModuleLoader__.load({
  id: "dsh-video-subtitle",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;

    const NS = "dsh-video-subtitle";
    const API = "/api/video-subtitle";
    const inject = ["slots", "locale"];

    const zh = {
      nav: "视频字幕",
      title: "视频字幕",
      subtitle: "取 B站 视频字幕：官方字幕要登录，登录一次就好。",
    };
    const en = {
      nav: "Video subtitles",
      title: "Video subtitles",
      subtitle: "Fetch Bilibili subtitles. Official subtitles need a one-time login.",
    };

    // ---------- 样式：自己插一个 style 标签，按 tagId 去重，热更新时不会叠一层又一层 ----------
    const css = [
      ".vsub-root{display:flex;flex-direction:column;gap:18px;padding:4px 2px 28px}",
      ".vsub-card{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));border-radius:12px;padding:16px 16px 14px;display:flex;flex-direction:column;gap:10px}",
      ".vsub-card h3{margin:0;font-size:15px;font-weight:600}",
      ".vsub-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".vsub-muted{opacity:.72;font-size:13px;line-height:1.6;margin:0}",
      ".vsub-btn{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.35));background:var(--dsw-alias-bg-secondary,transparent);color:inherit;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer}",
      ".vsub-btn:hover{opacity:.85}",
      ".vsub-btn:disabled{opacity:.45;cursor:default}",
      ".vsub-btn.primary{background:#3b82f6;border-color:#3b82f6;color:#fff}",
      ".vsub-badge{font-size:12px;border-radius:999px;padding:2px 9px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.3))}",
      ".vsub-badge.ok{color:#16a34a;border-color:#16a34a55}",
      ".vsub-badge.bad{color:#dc2626;border-color:#dc262655}",
      ".vsub-field{display:grid;grid-template-columns:170px 1fr;gap:10px;align-items:center;font-size:13px}",
      ".vsub-field input[type=text],.vsub-field input[type=number],.vsub-field select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.35));background:transparent;color:inherit;font-size:13px}",
      ".vsub-log{max-height:220px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;background:rgba(127,127,127,.08);border-radius:8px;padding:10px}",
      ".vsub-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000}",
      ".vsub-modal{background:var(--dsw-alias-bg-primary,#fff);color:inherit;border-radius:14px;padding:22px;max-width:380px;width:calc(100% - 40px);display:flex;flex-direction:column;gap:12px;align-items:center}",
      ".vsub-qr svg{display:block;width:240px;height:240px;background:#fff;border-radius:8px}",
    ].join("\n");

    function ensureStyle() {
      if (typeof document === "undefined") return;
      const tagId = "dsh-video-subtitle/settings.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = NS;
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
      const registry = (globalThis.__DSH_PLUGIN_CSS__ ??= []);
      if (!registry.some((e) => e.tagId === tagId)) registry.push({ tagId, css });
    }

    // ---------- 跟服务端说话 ----------
    async function call(path, options) {
      const init = { credentials: "same-origin", ...(options ?? {}) };
      if (init.body && typeof init.body !== "string") {
        init.headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };
        init.body = JSON.stringify(init.body);
      }
      const res = await fetch(API + path, init);
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error("服务端返回的不是 JSON：" + text.slice(0, 120));
      }
      if (!res.ok && !(data && data.error)) {
        throw new Error("请求失败（" + res.status + "）");
      }
      return data;
    }

    function textOf(value, fallback) {
      const s = value == null ? "" : String(value);
      return s || (fallback ?? "");
    }

    // ---------- 二维码弹层 ----------
    function LoginModal(props) {
      const [state, setState] = react.useState({ loading: true, svg: "", key: "", message: "正在生成二维码…", state: "pending" });
      const timer = react.useRef(null);

      const refresh = react.useCallback(async () => {
        setState((s) => ({ ...s, loading: true, message: "正在生成二维码…" }));
        try {
          const r = await call("/login/qr");
          if (!r.ok) {
            setState({ loading: false, svg: "", key: "", message: textOf(r.error, "生成二维码失败"), state: "error" });
            return;
          }
          setState({ loading: false, svg: r.svg, key: r.qrcodeKey, message: "用手机 B站 扫这个码，扫完在手机上确认登录", state: "pending" });
        } catch (e) {
          setState({ loading: false, svg: "", key: "", message: "生成二维码失败：" + e.message, state: "error" });
        }
      }, []);

      react.useEffect(() => {
        refresh();
      }, [refresh]);

      react.useEffect(() => {
        if (!state.key || state.state === "ok") return undefined;
        timer.current = setInterval(async () => {
          try {
            const r = await call("/login/poll?key=" + encodeURIComponent(state.key));
            if (!r.ok) {
              setState((s) => ({ ...s, message: textOf(r.error, "查询扫码结果失败"), state: "error" }));
              return;
            }
            if (r.state === "ok") {
              setState((s) => ({ ...s, message: textOf(r.message, "登录成功"), state: "ok" }));
              clearInterval(timer.current);
              setTimeout(() => props.onDone(true), 900);
              return;
            }
            if (r.state === "expired") {
              setState((s) => ({ ...s, message: "二维码过期了，点一下重新生成", state: "expired" }));
              clearInterval(timer.current);
              return;
            }
            setState((s) => ({ ...s, message: textOf(r.message, s.message), state: r.state }));
          } catch (e) {
            setState((s) => ({ ...s, message: "查询扫码结果失败：" + e.message, state: "error" }));
          }
        }, 2000);
        return () => clearInterval(timer.current);
      }, [state.key, state.state, props]);

      const expired = state.state === "expired" || state.state === "error";

      return h(
        "div",
        { className: "vsub-mask", onClick: (e) => { if (e.target === e.currentTarget) props.onClose(); } },
        h(
          "div",
          { className: "vsub-modal" },
          h("h3", { style: { margin: 0, fontSize: 16 } }, "登录 B站"),
          h(
            "div",
            { className: "vsub-qr", style: { position: "relative" } },
            state.svg
              ? h("div", { dangerouslySetInnerHTML: { __html: state.svg } })
              : h("div", { style: { width: 240, height: 240, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(127,127,127,.12)", borderRadius: 8, fontSize: 13 } }, state.loading ? "生成中…" : "没有二维码"),
          ),
          h("p", { className: "vsub-muted", style: { textAlign: "center" } }, state.message),
          h(
            "div",
            { className: "vsub-row", style: { justifyContent: "center" } },
            expired ? h("button", { className: "vsub-btn primary", onClick: refresh }, "重新生成二维码") : null,
            h("button", { className: "vsub-btn", onClick: props.onClose }, "关闭"),
          ),
          h("p", { className: "vsub-muted", style: { fontSize: 12, textAlign: "center" } }, "扫码只是拿一份本机登录凭据，存在你自己的电脑上，不会上传到任何地方。"),
        ),
      );
    }

    // ---------- 设置页主体 ----------
    function Section(props) {
      const [status, setStatus] = react.useState(null);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [showLogin, setShowLogin] = react.useState(false);
      const [asr, setAsr] = react.useState(null);
      const [draft, setDraft] = react.useState({});
      const [savedTip, setSavedTip] = react.useState("");

      const load = react.useCallback(async () => {
        try {
          const r = await call("/status");
          setStatus(r);
          setError("");
          return r;
        } catch (e) {
          setError("读不到插件状态：" + e.message);
          return null;
        }
      }, []);

      react.useEffect(() => {
        load();
      }, [load]);

      // 有安装任务在跑的时候每秒刷一次进度
      const running = asr && asr.running;
      react.useEffect(() => {
        if (!running) return undefined;
        const id = setInterval(async () => {
          try {
            const r = await call("/asr/state");
            setAsr(r);
            if (r && r.running === false) {
              clearInterval(id);
              load();
            }
          } catch {
            clearInterval(id);
          }
        }, 1200);
        return () => clearInterval(id);
      }, [running, load]);

      const login = status && status.login ? status.login : null;
      const settings = (status && status.settings) || [];
      const valueOf = (key) => {
        if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key];
        const item = settings.find((s) => s.key === key);
        return item ? item.value : null;
      };
      const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

      const save = async () => {
        if (!Object.keys(draft).length) {
          setSavedTip("没有改动");
          return;
        }
        setBusy("save");
        try {
          const r = await call("/settings", { method: "POST", body: draft });
          if (!r.ok) throw new Error(textOf(r.error, "保存失败"));
          setDraft({});
          setSavedTip("已保存，马上生效");
          await load();
          setTimeout(() => setSavedTip(""), 2500);
        } catch (e) {
          setSavedTip("保存失败：" + e.message);
        } finally {
          setBusy("");
        }
      };

      const startSetup = async () => {
        setBusy("asr");
        try {
          const r = await call("/asr/setup", { method: "POST", body: {} });
          if (!r.ok) throw new Error(textOf(r.error, "启动安装失败"));
          const s = await call("/asr/state");
          setAsr(s);
        } catch (e) {
          setSavedTip("启动安装失败：" + e.message);
        } finally {
          setBusy("");
        }
      };

      const cancelSetup = async () => {
        try {
          await call("/asr/cancel", { method: "POST", body: {} });
          const s = await call("/asr/state");
          setAsr(s);
        } catch {
          /* 取消失败就算了，用户还能再点一次 */
        }
      };

      const asrReady = status && status.asr ? status.asr.ready : false;
      const asrSteps = (asr && asr.steps) || (status && status.asr && status.asr.steps) || [];

      return h(
        "div",
        { className: "vsub-root" },
        h("div", null, h("h2", { style: { margin: "0 0 4px", fontSize: 17 } }, props.title || "视频字幕"),
          h("p", { className: "vsub-muted" }, props.subtitle || "取 B站 视频字幕：官方字幕要登录，登录一次就好。")),

        error ? h("p", { className: "vsub-muted", style: { color: "#dc2626" } }, error) : null,

        // 1. 登录
        h(
          "div",
          { className: "vsub-card" },
          h(
            "div",
            { className: "vsub-row" },
            h("h3", null, "B站 登录"),
            h("span", { className: "vsub-badge " + (login && login.loggedIn ? "ok" : "bad") },
              login && login.loggedIn ? "已登录" : "未登录"),
            login && login.loggedIn && login.uname ? h("span", { className: "vsub-muted" }, login.uname) : null,
            h("span", { style: { flex: 1 } }),
            h("button", { className: "vsub-btn " + (login && login.loggedIn ? "" : "primary"), onClick: () => setShowLogin(true), disabled: busy === "login" },
              login && login.loggedIn ? "换一个账号" : "扫码登录"),
            login && login.loggedIn
              ? h("button", { className: "vsub-btn", onClick: async () => {
                  setBusy("login");
                  try {
                    await call("/login/logout", { method: "POST", body: {} });
                    await load();
                  } finally {
                    setBusy("");
                  }
                } }, "退出登录")
              : null,
          ),
          h("p", { className: "vsub-muted" },
            login && login.loggedIn
              ? "登录后能拿到官方 AI 字幕，通常是秒级返回，而且不用本机转写，又快又准。"
              : "不登录也能取到一部分公开字幕，但官方 AI 字幕必须登录。点上面的按钮，用手机 B站 扫一下就成。"),
          login && !login.loggedIn && login.detail ? h("p", { className: "vsub-muted", style: { fontSize: 12 } }, login.detail) : null,
        ),

        // 2. 转写环境
        h(
          "div",
          { className: "vsub-card" },
          h(
            "div",
            { className: "vsub-row" },
            h("h3", null, "本机转写"),
            h("span", { className: "vsub-badge " + (asrReady ? "ok" : "bad") }, asrReady ? "已就绪" : "缺东西"),
            h("span", { style: { flex: 1 } }),
            running
              ? h("button", { className: "vsub-btn", onClick: cancelSetup }, "取消安装")
              : h("button", { className: "vsub-btn " + (asrReady ? "" : "primary"), onClick: startSetup, disabled: busy === "asr" }, asrReady ? "重新检查" : "一键安装"),
          ),
          h("p", { className: "vsub-muted" },
            asrReady
              ? "没有官方字幕的视频会自动用本机转写兜住，占的是自己的电脑，不限次数，30 分钟的视频大约两三分钟。"
              : "没有官方字幕的视频要靠本机转写兜住。现在缺零件，点上面的一键安装，装完就能用。"),
          asrSteps.length
            ? h("ul", { className: "vsub-muted", style: { margin: "4px 0 0", paddingLeft: 20 } },
                asrSteps.map((s) => h("li", { key: s.id },
                  (s.state === "done" || s.done === true ? "✔ " : s.state === "running" ? "… " : s.state === "failed" ? "✘ " : "· ") + s.label + (s.detail ? "：" + s.detail : ""))))
            : null,
          asr && asr.log && asr.log.length
            ? h("div", { className: "vsub-log" }, asr.log.slice(-40).join("\n"))
            : null,
        ),

        // 3. 来源健康状况
        h(
          "div",
          { className: "vsub-card" },
          h("div", { className: "vsub-row" }, h("h3", null, "字幕来源"), h("span", { style: { flex: 1 } }),
            h("button", { className: "vsub-btn", onClick: load }, "刷新")),
          h("p", { className: "vsub-muted" }, "按顺序试，前一个拿不到才轮到下一个。"),
          h("ul", { className: "vsub-muted", style: { margin: 0, paddingLeft: 20 } },
            ((status && status.providers) || []).map((p) => h("li", { key: p.provider },
              p.provider + (p.wired ? "" : "（未接线）") + "：" +
              (p.placeholder || p.note || "可用")))),
        ),

        // 4. 常用设置
        h(
          "div",
          { className: "vsub-card" },
          h("h3", null, "常用设置"),
          h("p", { className: "vsub-muted" }, "这里改的东西存在你自己电脑上，改完立刻生效，不用重启。"),

          h("label", { className: "vsub-field" },
            h("span", null, "要哪种语言"),
            h("select", { value: textOf(valueOf("preferLang"), "auto"), onChange: (e) => setField("preferLang", e.target.value) },
              h("option", { value: "auto" }, "自动（优先中文）"),
              h("option", { value: "zh" }, "只要中文"),
              h("option", { value: "en" }, "只要英文"))),

          h("label", { className: "vsub-field" },
            h("span", null, "存到当前工作区"),
            h("input", { type: "checkbox", checked: valueOf("saveToWorkspace") !== false, onChange: (e) => setField("saveToWorkspace", e.target.checked) })),

          valueOf("saveToWorkspace") !== false
            ? h("label", { className: "vsub-field" },
                h("span", null, "工作区里的子目录"),
                h("input", { type: "text", value: textOf(valueOf("workspaceSubdir"), ".subtitles"), onChange: (e) => setField("workspaceSubdir", e.target.value) }))
            : h("label", { className: "vsub-field" },
                h("span", null, "固定保存目录"),
                h("input", { type: "text", placeholder: "例：D:\\我的字幕", value: textOf(valueOf("saveDir")), onChange: (e) => setField("saveDir", e.target.value) })),

          h("label", { className: "vsub-field" },
            h("span", null, "转写模型"),
            h("select", { value: textOf(valueOf("whisperModel"), "small"), onChange: (e) => setField("whisperModel", e.target.value) },
              h("option", { value: "tiny" }, "最快（准确率低一些）"),
              h("option", { value: "base" }, "快"),
              h("option", { value: "small" }, "推荐"),
              h("option", { value: "medium" }, "最准（慢，占内存多）"))),

          h("label", { className: "vsub-field" },
            h("span", null, "缓存保留天数"),
            h("input", { type: "number", min: 0, max: 365, value: Number(valueOf("cacheTtlDays") ?? 30), onChange: (e) => setField("cacheTtlDays", Number(e.target.value)) })),

          h("label", { className: "vsub-field" },
            h("span", null, "完整度门槛（%）"),
            h("input", { type: "number", min: 10, max: 100, value: Number(valueOf("fullCoveragePct") ?? 90), onChange: (e) => setField("fullCoveragePct", Number(e.target.value)) })),

          h("div", { className: "vsub-row", style: { marginTop: 4 } },
            h("button", { className: "vsub-btn primary", onClick: save, disabled: busy === "save" }, "保存设置"),
            savedTip ? h("span", { className: "vsub-muted" }, savedTip) : null,
            h("span", { style: { flex: 1 } }),
            h("span", { className: "vsub-muted", style: { fontSize: 12 } }, "版本 " + textOf(status && status.version, "-"))),
        ),

        showLogin
          ? h(LoginModal, {
              onClose: () => setShowLogin(false),
              onDone: () => {
                setShowLogin(false);
                load();
              },
            })
          : null,
      );
    }

    function apply(ctx) {
      ensureStyle();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: NS,
            order: 70,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ t, locale: ctx.locale }),
          },
          () => h(Section, { title: t("title"), subtitle: t("subtitle") }),
        ),
      );
    }

    const name = NS;
    const module = { exports: {} };
    module.exports = { apply, inject, name };
    return module.exports;
  },
});
