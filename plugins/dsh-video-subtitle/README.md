# dsh-video-subtitle

DSH 工具插件：把一个视频的字幕取成本地 `.srt` 文件。以 B站为主，YouTube 预留。

在 DSH 的设置页里显示的名字是「视频字幕下载」，带一个蓝色播放器图标（`locale/zh.json`、`locale/en.json`、`icon.svg`）。

设置里多出一页「视频字幕」：扫码登录、看本机转写环境缺什么、一键安装、改常用的几项设置，都在这一页上点。

**设计原则**：字幕正文永不自动进入模型上下文。一次 `subtitle_fetch` 只花几百 token 拿元数据（标题/时长/字数/路径），要看内容再用 `subtitle_read` 按时间区间分段读。

## 装好之后怎么用

1. 打开 DSH 的设置，在左边找到「视频字幕」这一页。
2. 点「扫码登录」，用手机 B站 扫屏幕上的二维码，手机上确认一次就好。凭据存在 `<DSH_HOME>/video-subtitle/bili-login.json`，只在取字幕时读进内存，不打印、不上传。不登录也能用，只是 B站 的官方 AI 字幕需要登录才给地址。
3. 回到对话里直接让模型取字幕，比如发一条视频链接说「把这条视频的字幕取下来」。本机转写环境缺东西时，回到这一页点「一键安装」，装的过程中进度会一步步显示出来。

## 五个工具

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `subtitle_fetch` | 取字幕 → 写 `.srt` → 回元数据 | `url`（必填）、`lang`、`dir`、`force` |
| `subtitle_read` | 按区间读已存的 `.srt` | `path`（必填）、`from`、`to`、`max_chars`（默认 6000） |
| `subtitle_batch` | 一次取多条，或展开整部合集的分P逐P取 | `urls`（必填，可整段粘贴）、`parts`、`lang`、`dir`、`force`、`max_items` |
| `subtitle_polish` | 把碎片字幕拼回句子、补标点，另写纯文稿 | `path`（必填）、`dir`、`max_gap`、`max_chars` |
| `subtitle_providers` | 报告 provider 链状态与最近一次结果 | 无 |

状态里会照实写出本机缺哪样（`whisper` 缺 Python 环境或模型缓存；`local` 缺 ffmpeg / sherpa-onnx 模型 / 词表），不再写「占位」这种过期说法。`native` 那行会写出登录凭据读的是哪个文件（只写文件位置，不写凭据内容）。

### 批量与整理

- `subtitle_batch` 的 `urls` 接受数组或一整段粘贴的文本（换行、逗号、空格分隔都行），以 `[` 开头的字符串会先按 JSON 数组解析。`parts=true` 时先调 `view` 接口把合集的 `pages` 全部展开，一个分P 一条目标。某一条失败不影响其它条；超过 `max_items` 的条数在结果里写成 `truncated` 并如实报出还剩几条，不会静默丢掉。
- `subtitle_polish` 只做两件事：按时间间隔把碎片并回句子、插入标点。**一个原字都不改、不删、不译、不换顺序**——字幕是别人说的话，改写等于伪造内容。输出与源文件同目录：`<原名>.polished.srt` 与 `<原名>.polished.txt`，原始 `.srt` 保留不动。
- B站 官方 AI 字幕是逐句短碎片、完全没有标点（实测某视频 685 段平均 12 字/段、标点数为 0），要给人读、要引用或要总结之前，先跑一遍 `subtitle_polish`。

## Provider 链（按序尝试，全部失败才报 `ok:false`）

| 顺序 | provider | 原理 | 外部服务 | 凭据 |
|---|---|---|---|---|
| 1 | `native` | 先匿名 `/x/player/v2`；没轨则读本机登录凭据 + WBI 签名调 `/x/player/wbi/v2` | 只访问 B站 官方接口 | 本机 B站 登录凭据 |
| 2 | `whisper` | 本机 faster-whisper 转写（playurl 音频 → Python 转写 → SRT） | 无 | 无 |
| 3 | `local` | 本机 SenseVoice 转写（需 ffmpeg + sherpa-onnx 模型） | 无 | 无 |

整条链只碰 B站 官方接口与本机：没有第三方站点，包里也没有任何他人代码。

- `native` 是**主力源**：B站 的官方 AI 字幕轨要「已登录 + WBI 签名」才返回 `subtitle_url`，匿名一律拿不到（实测 27 个视频：匿名 0 个有轨，登录后 23 个有轨）。
- 要到登录状态有两条路，**先用第一条**：一是到设置里的「视频字幕」页点扫码登录，用手机 B站 扫一下，凭据自动存进 `<DSH_HOME>/video-subtitle/bili-login.json`；二是老用户已经在用的 `<DSH_HOME>/bili-duty/bili_credential.json`，插件照样认，只是兼容用的，不算主路。也可以在 `biliCookie` 里直接写一整条 Cookie 串应急。
- 拿到登录凭据后，插件先按匿名方式试一次（公开字幕轨照样能拿），没轨再按 B站 的 WBI 规则给参数签名后重新要一次。实测常规视频 0.5~1.4 秒返回、覆盖 100%。凭据只在本机内存里用，不打印、不写回、不上传；`subtitle_providers` 里只显示读的是哪个文件。
- `whisper` 是备用本机源：匿名取 playurl 的 dash 音频 → 本机 Python（faster-whisper，CPU int8）转写 → SRT。**不依赖任何外部服务、没有次数限制、任何有声音的视频都能转**。音频由 PyAV 直接解码，不需要 ffmpeg。
- `whisper` 的零件不用自己装：在设置里的「视频字幕」页点「一键安装」，它会建好 Python 虚拟环境、装 faster-whisper、下好模型，装在 `<DSH_HOME>/video-subtitle/asr` 下，装的过程中每一步的进度都显示在页面上。本机已经有一套老的 `<DSH_HOME>/bili-duty/.venv-asr` 加 `.hf-cache` 时直接接着用，不逼人重装。想自己指定位置就填 `whisperPython` / `whisperHfHome`，填了听填的。
- `whisper` 的代价是慢，但已经比原来快一截：默认打开批处理（`whisperBatchSize` 默认 8）并取词级时间戳，再按标点或 `whisperMaxChars`（默认 24 字）重新切成短条目。实测 180 秒音频从 22.5 秒降到 17.9 秒（约 1.25 倍）、条目从 54 段细化到 61 段平均 3.03 秒；1494 秒整段 130.9 秒，约 11 倍实时，30 分钟视频约 2 分半。批处理不可用时自动退回逐段转写，结果一样能用。所以它的超时上限单独按 `whisperTimeoutMs`（默认 30 分钟）算，不跟别的源共用 90 秒；工具总等待上限也自动把它算进去。
- `whisper` 转写完整段音频，结果标记 `fullAudioProcessed: true`；语种由模型自己判断，写进轨道的 `lang`。
- `whisper` 会先对一次账：B站 匿名 playurl 对一部分视频**只给试看片段**（实测某 72 分钟视频只给 616 秒音频），`dash.duration` 会如实标出片段长度。音频比视频短 5% 以上时直接报 `AUDIO_TRUNCATED`，不去转那一小段冒充整片。这类视频登录也不一定能解（实测同一账号：43 分钟的给了完整音频，72 分钟的仍只有 616 秒），属于 B站 侧限制。
- `local` 是另一条本机路线（SenseVoice），本机缺 ffmpeg 与模型时不可用，状态里会照实列出缺什么。
- WBI 签名规则与 key 缓存写在 `lib/wbi.js`（key 从 `/x/web-interface/nav` 现取，缓存 1 小时）；登录凭据读取与字段映射写在 `lib/bili-credential.js`，按文件修改时间缓存，缺哪个字段就照实说缺哪个。找凭据的顺序是：配置里写死的 Cookie → 配置里指定的文件 → 设置页扫码登录存下的文件 → 旧的 bili-duty 凭据文件，先找到先用。B站 换签名规则时只改 `lib/wbi.js`。
- 覆盖度低于 60% 时输出会追加 `⚠ 覆盖不足，可能只转了一小段`。
- 工具输出带**覆盖度**（`覆盖 起始–结束（视频的 N%）`），用于识破 ASR 只转了一小段的情况。
- **完整度门槛**：只有覆盖 ≥ `fullCoveragePct`（默认 90%）才算成功。低于门槛时：**不写文件**，结果返回 `ok:false` + `partial:true`，输出明确写「不能作为谈论视频内容的依据」。残片既不写盘也不进入缓存，下次调用会重新尝试。
- **按完整度择优**：provider 按顺序尝试，但保留完整度最高的一条；只有当某条达到门槛才提前收工。谁先出结果不算数。
- **时间轴校验**：provider 返回的轨先过一遍时间轴检查——起止倒挂、段落起点往回跳 10 秒以上、时间戳超出视频总长，都判为坏数据。整条 provider 都不可信时记为 `BAD_TIMELINE` 并继续试下一个源；同一 provider 里只有部分轨坏时只剔除坏的那几条。坏时间轴的旧文件也不再被当缓存复用。某些源会把整条时间轴写错（视频只有 3 分半，某段却标成 13 分 26 秒），没有这道检查时它会因为算出 128% 覆盖而挤掉正确结果。
- **同一视频并发只跑一次**：同一个视频同时被要两次时，后到的请求直接等先到的那一份结果（返回值多一个 `shared: true`），不再各跑一遍完整抓取链、各写一遍同一个文件。共享的那次抓取自己带取消开关：谁取消只结束谁的等待，等的人全没了才真的停。
- **缓存命中会写明来源**：命中本地已有文件时，结果里写清这份字幕是哪个源给的（`CACHED` + provider 名），排障时不用猜是谁给的。
- **过期旧文件自动清理**：每次取字幕顺手把这个视频超过 `cacheTtlDays` 的旧 `.srt` 与 `.meta.json` 删掉，字幕目录不会只增不减。只动同一个视频前缀的文件，不碰别的视频、也不碰用户自己放进去的文件。命中过的文件会刷新修改时间，常用的不会到期被当垃圾清掉。
- **多轨视频不白跑语种探测**：标题/简介已经能判断出原文语种、且轨道里就有这一条时，不再解码音频探测（那要拉起 ffmpeg 加一次识别，白花十几秒）；只有判断不出才探测。探测长度由 `localProbeSec`（默认 60 秒）控制，设 0 关闭。

## 配置（默认值在 `cordis.patch.yml`，profile 层可覆盖，设置页改的会盖在它上面）

```
enabled: true
providerOrder: ['native', 'whisper', 'local']
saveDir: ''                  # 固定目录；空 = 交给 saveToWorkspace 策略
saveToWorkspace: true        # true = 写进发起调用的那个会话自己的工作区（每次调用实时解析）
workspaceSubdir: '.subtitles' # 会话工作区里的子目录名；写文件时自动创建
preferLang: ['zh', 'en']
timeoutMs: 90000             # 单个 provider 的超时；工具总等待上限 = 30 秒取视频信息 + 每个启用的源各一份 + 15 秒写文件余量
whisperPython: ''            # 留空 = 用设置页一键安装的位置 <DSH_HOME>/video-subtitle/asr/venv/Scripts/python.exe；本机已有旧的 bili-duty 那套就接着用
whisperHfHome: ''            # 留空 = 用 <DSH_HOME>/video-subtitle/asr/hf-cache；本机已有旧的 bili-duty 那套就接着用
whisperTmpDir: ''            # 转写临时文件目录；留空用 <DSH_HOME>/video-subtitle/asr/tmp
whisperModel: small          # faster-whisper 模型名（已缓存的：small）
whisperThreads: 4
whisperBatchSize: 8          # 批处理一次喂几段音频；实测比逐段快约 1.25 倍，0 = 关掉
whisperMaxChars: 24          # 词级时间戳按多少字收一条；越小越细碎
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
biliCookie: ''               # B站 登录 Cookie；留空 = 先用设置页扫码登录存下的 <DSH_HOME>/video-subtitle/bili-login.json，其次兼容旧的 <DSH_HOME>/bili-duty/bili_credential.json
biliCredentialFile: ''        # 显式指定凭据文件位置；填了只读这个文件
batchMaxItems: 20             # 批量单次最多跑几条；截掉的条数会如实报出
```

上面这份是给命令行用户看的默认值。普通人不用改它：设置里的「视频字幕」页能改八项——`preferLang`（auto / zh / en）、`saveToWorkspace`、`workspaceSubdir`、`saveDir`、`cacheTtlDays`、`fullCoveragePct`、`whisperModel`、`whisperBatchSize`。在页面上改完的值写进 `<DSH_HOME>/video-subtitle/settings.json`，读的时候盖在这份 YAML 上面，所以以页面为准；每次取字幕都重新读这个文件，改完立刻生效，不用重启。

## 服务端接口

设置页那一半不能直接读服务器上的文件，所以插件在 `/api/video-subtitle` 下开了几个接口，只用来报状态、扫码登录、装转写环境、读写设置。字幕正文一律不经过这些接口。

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/video-subtitle/status` | GET | 一次报齐：登录状态、转写环境四步体检、几个字幕源的状况、当前设置、几处目录、安装提示 |
| `/api/video-subtitle/login/qr` | GET | 生成登录二维码，回二维码标识、SVG 图和过期时间 |
| `/api/video-subtitle/login/poll` | GET | 拿二维码标识查扫码结果；成功时顺手把凭据存好 |
| `/api/video-subtitle/login/logout` | POST | 删掉设置页存下的凭据 |
| `/api/video-subtitle/asr/setup` | POST | 开始一键安装转写环境，立刻返回任务号 |
| `/api/video-subtitle/asr/state` | GET | 读安装进度：当前第几步、每步状态、日志 |
| `/api/video-subtitle/asr/cancel` | POST | 停掉正在跑的安装 |
| `/api/video-subtitle/asr/hint` | GET | 给出这台机器上缺什么、该敲哪条命令手动装 |
| `/api/video-subtitle/settings` | POST | 保存设置页改的那几项 |

## 文件布局

```
lib/index.js                name/inject/Config/apply + 五个工具注册 + 系统提示段落
lib/client.js               设置页那一半界面：扫码登录、装转写环境、改设置
lib/api.js                  /api/video-subtitle 下那几个接口，给设置页取数据和下命令
lib/settings.js             设置页改的那八项，读写 <DSH_HOME>/video-subtitle/settings.json
lib/bili-login.js           扫码登录：要二维码、查扫码结果、校验账号、存凭据
lib/qr.js                   自己算二维码点阵，不依赖第三方二维码包
lib/asr-env.js              本机转写环境装在哪个目录、缺什么、一键安装
cordis.patch.yml            dsh.bundle.patch 指向；默认配置
locale/zh.json              设置页显示的中文名与说明
locale/en.json              英文名与说明
icon.svg                    设置页图标（原创）
test/*.test.js              自动测试（node --test，122 项）
lib/pipeline.js             provider 链调度、缓存、写文件、read/status/polish
lib/ids.js                  URL/BV/av/b23.tv/分P 解析、view 接口取 cid
lib/srt.js                  utterances→SRT、容错解析、区间切片、语种比对
lib/wbi.js                  B站 WBI 签名（mixinKey、w_rid、key 缓存）
lib/bili-credential.js      本机登录凭据读取与字段映射（只读取，不回写）
lib/batch.js                批量/合集分P展开与逐条抓取
lib/text-format.js          碎片并句、补标点、纯文稿
lib/providers/native.js     官方字幕轨（匿名 + 登录签名）
lib/providers/whisper.js    本机 faster-whisper 转写（批处理 + 词级切条）
lib/providers/local.js      本机 SenseVoice 转写（ffmpeg 异步解码 + sherpa-onnx 识别）
```

## 跑测试

```
npm test
```

122 项自动测试：编号解析（BV/av/分P/短链/别站误吃）、字幕解析与时间轴校验、区间读取与超长单句截断、语种按整词比对、等待上限随源数量变化（含 whisper 单独留出转写时间）、本地源缺件说明、子进程超时/取消/并行、WBI 签名（key 提取、mixinKey 重排、w_rid 等于 query 拼 key 的 md5、参数顺序无关、五个字符剥离）、native 的四种身份组合（匿名有轨/匿名无轨转签名/无凭据/凭据过期）与坏轨跳过、批量解析与逐条容错、碎片并句与补标点、词级切条，以及这次新加的几块：扫码登录（二维码地址与过期时间、五种扫码状态、Cookie 拼接、成功与失败时的错误文字都不许带凭据）、二维码逐格比对（自己算的点阵跟参照包比、格式信息与版本信息写对、四种纠错等级）、转写环境四步体检（解释器/依赖包/模型/临时目录，老环境复用与正式位置、装到一半失败、同一时间只跑一个任务、日志里抹掉用户名与 token）、批量与设置页那几块，以及插件清单本身（声明了客户端一半、指向的文件真实存在、客户端里除了平台的 react 不许有别的依赖、版本号只写在清单一处）。全部是本地跑、不联网。

写出来的文件名：`<bvid>[-pN].<lang>.<provider>.srt`，同目录另写 `<bvid>.meta.json`（本次 provider 链逐项结果）。

## 站点改版时改哪里

| 变化 | 改这里 |
|---|---|
| B站 换接口 | `lib/providers/native.js` / `lib/providers/whisper.js` |
| B站 换签名规则 | `lib/wbi.js`（只改这个文件，两个源共用） |
| 登录凭据换位置/换格式 | `cordis.patch.yml` 的 `biliCredentialFile`，或改 `lib/bili-credential.js` 的字段映射 |
| 扫码登录相关的官方接口变了 | `lib/bili-login.js`（要二维码、查结果、校验账号都在这一个文件里） |
| 设置页界面要加东西 | `lib/client.js` 画页面、`lib/api.js` 加接口、`lib/settings.js` 加能改的字段 |
| 转写环境的安装步骤变了 | `lib/asr-env.js` 的 `STEPS` 四步 |

## 不做什么

不接第三方字幕站：试过一家，每天只放两次成功解析、常年解析失败，加密实现还得照抄对方网页代码，已整站移除。不碰浏览器（不读浏览器里存的 Cookie、不打开浏览器），但提供 B站 官方的扫码登录；不下载视频本体；不抓弹幕/评论/封面；不做总结（总结是模型的事）；除字幕源外不外传任何数据。

登录凭据是唯一的例外：`native` 需要它才能拿到官方 AI 字幕轨。在设置页扫码登录成功后，凭据存在 `<DSH_HOME>/video-subtitle/bili-login.json`；老用户的 `<DSH_HOME>/bili-duty/bili_credential.json` 也兼容。每次取字幕只把这份凭据读进内存、拼进请求头，不打印、不写回、不写进任何输出文件，`subtitle_providers` 与出错信息里也只写读的是哪个文件、缺哪个字段。
