# dsh-video-subtitle

DSH 工具插件：把一个视频的字幕取成本地 `.srt` 文件。以 B站为主，YouTube 预留。

在 DSH 的设置页里显示的名字是「视频字幕下载」，带一个蓝色播放器图标（`locale/zh.json`、`locale/en.json`、`icon.svg`）。

**设计原则**：字幕正文永不自动进入模型上下文。一次 `subtitle_fetch` 只花几百 token 拿元数据（标题/时长/字数/路径），要看内容再用 `subtitle_read` 按时间区间分段读。

## 三个工具

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `subtitle_fetch` | 取字幕 → 写 `.srt` → 回元数据 | `url`（必填）、`lang`、`dir`、`force` |
| `subtitle_read` | 按区间读已存的 `.srt` | `path`（必填）、`from`、`to`、`max_chars`（默认 6000） |
| `subtitle_providers` | 报告 provider 链状态与最近一次结果 | 无 |

状态里会照实写出本机缺哪样（`whisper` 缺 Python 环境或模型缓存；`local` 缺 ffmpeg / sherpa-onnx 模型 / 词表），不再写「占位」这种过期说法。`feiyudo` 那行还会显示今天已取几条。

## Provider 链（按序尝试，全部失败才报 `ok:false`）

| 顺序 | provider | 原理 | 第三方依赖 | 凭据 |
|---|---|---|---|---|
| 1 | `native` | 匿名 `/x/player/v2`，有公开字幕轨直接取 | 无 | 无 |
| 2 | `feiyudo` | 运行时拉 k1/k2 → AES+RSA → `POST /api/video/subtitleExtract` | 有（该站） | 无 |
| 3 | `whisper` | 本机 faster-whisper 转写（playurl 音频 → Python 转写 → SRT） | 无 | 无 |
| 4 | `local` | 本机 SenseVoice 转写（需 ffmpeg + sherpa-onnx 模型） | 无 | 无 |

`bcut`（必剪匿名 ASR）已于 2026-10-19 移除：它对匿名请求限流（实测连续几次后 `HTTP 412`）、分配到的 `upos-sz-*` 节点全部失败，基本不可用。

- `whisper` 是当前的主力本机源：匿名取 playurl 的 dash 音频 → 本机 Python（faster-whisper，CPU int8）转写 → SRT。**不依赖任何第三方站点、没有次数限制、任何有声音的视频都能转**。音频由 PyAV 直接解码，不需要 ffmpeg。默认自动找 `<DSH_HOME>/bili-duty` 下现成的 Python 环境与模型缓存（`small` 模型），换机器时用 `whisperPython` / `whisperHfHome` 指过去。
- `whisper` 的代价是慢：实测约 1 分钟音频要 7~8 秒（4 线程 CPU）。6 分钟视频约 50 秒，16 分钟视频约 70 秒，43 分钟视频约 4 分钟。所以它的超时上限单独按 `whisperTimeoutMs`（默认 30 分钟）算，不跟别的源共用 90 秒；工具总等待上限也自动把它算进去。
- `whisper` 转写完整段音频，结果标记 `fullAudioProcessed: true`；语种由模型自己判断，写进轨道的 `lang`。
- `whisper` 会先对一次账：B站 匿名 playurl 对一部分视频**只给试看片段**（实测某 72 分钟视频只给 616 秒音频），`dash.duration` 会如实标出片段长度。音频比视频短 5% 以上时直接报 `AUDIO_TRUNCATED`，不去转那一小段冒充整片。这类视频登录也不一定能解（实测同一账号：43 分钟的给了完整音频，72 分钟的仍只有 616 秒），属于 B站 侧限制。
- `local` 是另一条本机路线（SenseVoice），本机缺 ffmpeg 与模型时不可用，状态里会照实列出缺什么。
- `native` 目前**未实现 WBI 签名兜底**，只调明文 `/x/player/v2`（该兜底此前实测对匿名无效，故不做）。
- `feiyudo` 按天限流：同一台机器每天只放**两次**成功解析，之后一律回 `code 500`「您今日的使用次数已达上限」。插件记下「日期 + 当日次数 + 站点是否已明确说用完」，跨天自动归零，站点说用完当天就不再白打请求。上限本身用 `feiyudoDailyMax` 调（默认 20，设 0 表示不自己限制）。`kedou.life` 与该站是同一后端、共用同一份额度，换域名不能绕过。
- 覆盖度低于 60% 时输出会追加 `⚠ 覆盖不足，可能只转了一小段`。
- 工具输出带**覆盖度**（`覆盖 起始–结束（视频的 N%）`），用于识破 ASR 只转了一小段的情况。
- **完整度门槛**：只有覆盖 ≥ `fullCoveragePct`（默认 90%）才算成功。低于门槛时：**不写文件**，结果返回 `ok:false` + `partial:true`，输出明确写「不能作为谈论视频内容的依据」。残片既不写盘也不进入缓存，下次调用会重新尝试。
- **按完整度择优**：provider 按顺序尝试，但保留完整度最高的一条；只有当某条达到门槛才提前收工。谁先出结果不算数。
- **时间轴校验**：provider 返回的轨先过一遍时间轴检查——起止倒挂、段落起点往回跳 10 秒以上、时间戳超出视频总长，都判为坏数据。整条 provider 都不可信时记为 `BAD_TIMELINE` 并继续试下一个源；同一 provider 里只有部分轨坏时只剔除坏的那几条。坏时间轴的旧文件也不再被当缓存复用。第三方站偶尔会把整条时间轴写错（视频只有 3 分半，某段却标成 13 分 26 秒），没有这道检查时它会因为算出 128% 覆盖而挤掉正确结果。
- **同一视频并发只跑一次**：同一个视频同时被要两次时，后到的请求直接等先到的那一份结果（返回值多一个 `shared: true`），不再各跑一遍完整抓取链、各写一遍同一个文件。共享的那次抓取自己带取消开关：谁取消只结束谁的等待，等的人全没了才真的停。
- **缓存命中会写明来源**：命中本地已有文件时，结果里写清这份字幕是哪个源给的（`CACHED` + provider 名），排障时不用猜是谁给的。
- **过期旧文件自动清理**：每次取字幕顺手把这个视频超过 `cacheTtlDays` 的旧 `.srt` 与 `.meta.json` 删掉，字幕目录不会只增不减。只动同一个视频前缀的文件，不碰别的视频、也不碰用户自己放进去的文件。命中过的文件会刷新修改时间，常用的不会到期被当垃圾清掉。
- **多轨视频不白跑语种探测**：标题/简介已经能判断出原文语种、且轨道里就有这一条时，不再解码音频探测（那要拉起 ffmpeg 加一次识别，白花十几秒）；只有判断不出才探测。探测长度由 `localProbeSec`（默认 60 秒）控制，设 0 关闭。

## 配置（默认值在 `cordis.patch.yml`，profile 层可覆盖）

```
enabled: true
providerOrder: ['native', 'feiyudo', 'whisper', 'local']
saveDir: ''                  # 固定目录；空 = 交给 saveToWorkspace 策略
saveToWorkspace: true        # true = 写进发起调用的那个会话自己的工作区（每次调用实时解析）
workspaceSubdir: '.subtitles' # 会话工作区里的子目录名；落盘时自动创建
preferLang: ['zh', 'en']
timeoutMs: 90000             # 单个 provider 的超时；工具总等待上限 = 30 秒取视频信息 + 每个启用的源各一份 + 15 秒落盘余量
feiyudoBaseUrl: 'https://www.feiyudo.com'
feiyudoMinIntervalMs: 3000   # 自控频率
feiyudoDailyMax: 20          # 每天最多取几条（0 = 不自己限制，完全听站点的）；跨天自动归零
whisperPython: ''            # 留空自动找 <DSH_HOME>/bili-duty/.venv-asr/Scripts/python.exe
whisperHfHome: ''            # 留空自动找 <DSH_HOME>/bili-duty/.hf-cache
whisperTmpDir: ''            # 转写临时文件目录；留空用 <DSH_HOME>/bili-duty/tmp/asr
whisperModel: small          # faster-whisper 模型名（已缓存的：small）
whisperThreads: 4
whisperLang: auto            # auto = 让模型判断；也可写 zh / en / ja
whisperTimeoutMs: 1800000    # 单个视频转写的时间上限（毫秒，默认 30 分钟）
whisperMaxMinutes: 180       # 超过这个时长的视频不做本地转写
fullCoveragePct: 90          # 完整度门槛：覆盖不到就判失败（残片）
keepOnlyOriginalLang: true   # 只保留原文语种那一条（按标题+简介判断）；判断不出原声语种时保留首选轨，并在结果里写明「这份是翻译、不是原声」
localWindowSec: 30           # 本地转写窗口长度（秒）
localThreads: 4
localMaxMinutes: 240
localProbeSec: 60            # 多轨视频判断原声语种时解码前多少秒音频；设 0 关闭探测
ffmpegPath: ''               # 留空自动查找
sherpaAddonPath: ''
senseVoiceModel: ''
senseVoiceTokens: ''
cacheTtlDays: 30
```

## 文件布局

```
lib/index.js                name/inject/Config/apply + 三个工具注册 + 系统提示段落
cordis.patch.yml            dsh.bundle.patch 指向；默认配置
locale/zh.json              设置页显示的中文名与说明
locale/en.json              英文名与说明
icon.svg                    设置页图标（原创）
test/*.test.js              自动测试（node --test，29 项）
lib/pipeline.js             provider 链调度、缓存、落盘、read/status
lib/ids.js                  URL/BV/av/b23.tv/分P 解析、view 接口取 cid
lib/srt.js                  utterances→SRT、容错解析、区间切片、语种比对
lib/providers/native.js     匿名字幕轨
lib/providers/feiyudo.js    第三方站（密钥运行时拉取）
lib/providers/whisper.js    本机 faster-whisper 转写（主力本机源）
lib/providers/local.js      本机 SenseVoice 转写（ffmpeg 异步解码 + sherpa-onnx 识别）
lib/feiyudo-cipher.js       固化的第三方加密实现（见下）
```

## 跑测试

```
npm test
```

29 项自动测试：编号解析（BV/av/分P/短链/别站误吃）、字幕解析与时间轴校验、区间读取与超长单句截断、语种按整词比对、等待上限随源数量变化（含 whisper 单独留出转写时间）、本地源缺件说明、子进程超时/取消/并行。全部是本地跑、不联网。

落盘文件名：`<bvid>[-pN].<lang>.<provider>.srt`，同目录另写 `<bvid>.meta.json`（本次 provider 链逐项结果）。

## 站点改版时改哪里

| 变化 | 改这里 |
|---|---|
| 第三方站换域名 | `cordis.patch.yml` 的 `feiyudoBaseUrl` |
| 第三方站换密钥 | **不用改**，密钥每次运行从 `/api/auth/keys` 拉 |
| 第三方站改加密格式/接口路径 | 重新固化 `lib/feiyudo-cipher.js` + 调整 `lib/providers/feiyudo.js` |
| 第三方站整站消失 | 把 `feiyudo` 从 `providerOrder` 里去掉；`whisper` 与 `local` 不依赖第三方 |
| B站 换接口 | `lib/providers/native.js` / `lib/providers/whisper.js` |

## 固化代码出处

`lib/feiyudo-cipher.js` 逐字复制自 `https://www.feiyudo.com/_nuxt/cipher.SrYGk1Pi.js`，抓取日期 2026-10-04，原始文件 SHA256：

```
22E597CF39B9C7B1B409DAD7CA9F02E40B99664F68C082E97FA80AB766FA8B62
```

两处编辑：① 它唯一的 `./entry.*.js` import 换成内联的 4 个符号定义（`Er`/`ur` 为 CJS interop、`J` = globalThis、`ve` 读 `setKeyStore` 存入的密钥）；② 导出列表追加 `setKeyStore`。AES/RSA 实现本身未改。

## 不做什么

不碰登录态/Cookie/扫码/浏览器；不下载视频本体；不抓弹幕/评论/封面；不做总结（总结是模型的事）；除 provider 外不外传任何数据。
