# dsh-video-subtitle

DSH 工具插件：把一个视频的字幕取成本地 `.srt` 文件。B站 走插件自己写的官方接口；别的视频站（YouTube 等）借一个现成的下载器去取站上自带的字幕，站上真没有就把声音取下来交给本机转写。

在 DSH 的设置页里显示的名字是「视频字幕下载」，带一个蓝色播放器图标（`locale/zh.json`、`locale/en.json`、`icon.svg`）。

设置里多出一页「视频字幕」：扫码登录、看「Whisper 语音转字幕」缺什么、一键安装、看「SenseVoice 语音转字幕」那三样零件装没装齐、一键安装、装别的站要用的那个下载器、改常用的几项设置，都在这一页上点。以前登录过但凭据不管用了的时候，这一页最上面会先出一条黄色提醒，带一个「重新扫码」按钮，不用等取字幕失败才发现。

这一页要重启一次桌面应用才会出现：插件是新装上的，应用启动时才会把设置页挂进去，装完不重启在左边找不到它。重启后一直都有，以后升级不用再重启。

**设计原则**：字幕正文永不自动进入模型上下文。一次 `subtitle_fetch` 只花几百 token 拿元数据（标题/时长/字数/路径），要看内容再用 `subtitle_read` 按时间区间分段读。

## 怎么装

这个插件还没发到 npm，只能从本机目录装。在命令行里执行一条命令，把插件目录挂进桌面应用所用的那份插件清单：

```
dsh plugin --profile desktop add <这个插件所在的目录>
```

装完**必须退出桌面应用再重开一次**，设置里才会出现「视频字幕」这一页。只装不重开，左边找不到它，这不是没装上。

装没装上，看两处就知道：插件清单里多了一项，插件目录里多了一个指向本仓库的链接。两处都没有，就是没装。

## 装好之后怎么用

1. 刚装好的话先退出桌面应用重开一次，然后打开 DSH 的设置，在左边找到「视频字幕」这一页。没重启就找不到这一页，不是没装上。
2. 点「扫码登录」，用手机 B站 扫屏幕上的二维码，手机上确认一次就好（这一页最上面出现黄色提醒时，说明以前存的凭据已经失效了，点提醒里的「重新扫码」重扫一次）。凭据存在 `<DSH_HOME>/video-subtitle/bili-login.json`，只在取字幕时读进内存，不打印、不上传。不登录也能用，只是 B站 的官方 AI 字幕需要登录才给地址。
3. 要取 B站 以外的视频（YouTube 等）时，先在这一页点「B站 以外的站用的下载器」那张卡片上的「一键安装」，十几兆，几秒钟装好。不装也不影响 B站 那些视频。
4. 回到对话里直接让模型取字幕，比如发一条视频链接说「把这条视频的字幕取下来」。两条本机路线或下载器缺东西时，回到这一页点「一键安装」，装的过程中进度会一步步显示出来。

## 五个工具

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `subtitle_fetch` | 取字幕 → 写 `.srt` → 回元数据 | `url`（必填，B站 的 BV/av/b23 或别的站的完整网址）、`lang`、`dir`、`force` |
| `subtitle_read` | 按区间读已存的 `.srt` | `path`（必填）、`from`、`to`、`max_chars`（默认 6000） |
| `subtitle_batch` | 一次取多条，或展开整部合集的分P逐P取 | `urls`（必填，可整段粘贴）、`parts`、`lang`、`dir`、`force`、`max_items` |
| `subtitle_polish` | 把碎片字幕拼回句子、补标点，另写纯文稿 | `path`（必填）、`dir`、`max_gap`、`max_chars` |
| `subtitle_providers` | 报告 provider 链状态与最近一次结果 | 无 |

状态里会照实写出本机缺哪样（`whisper` 缺 Python 运行环境或模型缓存；`local` 缺 FFmpeg / SenseVoice 模型 / 模型词表），不再写「占位」这种过期说法。`native` 那行会写出登录凭据读的是哪个文件（只写文件位置，不写凭据内容）。

取字幕失败时，回执不只有原因，第一段就是「下一步」：没登录就让人去设置页扫码、登录过期就说重新扫一次、Whisper 那条跑挂就让人照着卡片上的按钮装、只给了试看片段就说明要先登录、残片被门槛拦下就讲清那不是完整内容。同一套建议在 `subtitle_batch` 的每条失败项后面也会跟上。给建议只按这次实际试过的来源和这台机器此刻的状态算，凑不出具体办法时宁可不说废话。

### 批量与整理

- `subtitle_batch` 的 `urls` 接受数组或一整段粘贴的文本（换行、逗号、空格分隔都行），以 `[` 开头的字符串会先按 JSON 数组解析。`parts=true` 时先调 `view` 接口把合集的 `pages` 全部展开，一个分P 一条目标。某一条失败不影响其它条；超过 `max_items` 的条数在结果里写成 `truncated` 并如实报出还剩几条，不会静默丢掉。
- `subtitle_polish` 只做两件事：按时间间隔把碎片并回句子、插入标点。**一个原字都不改、不删、不译、不换顺序**——字幕是别人说的话，改写等于伪造内容。输出与源文件同目录：`<原名>.polished.srt` 与 `<原名>.polished.txt`，原始 `.srt` 保留不动。
- B站 官方 AI 字幕是逐句短碎片、完全没有标点（实测某视频 685 段平均 12 字/段、标点数为 0），要给人读、要引用或要总结之前，先跑一遍 `subtitle_polish`。

## Provider 链（按序尝试，全部失败才报 `ok:false`）

| 顺序 | provider | 原理 | 外部服务 | 凭据 |
|---|---|---|---|---|
| 1 | `native` | 先匿名 `/x/player/v2`；没轨则读本机登录凭据 + WBI 签名调 `/x/player/wbi/v2` | 只访问 B站 官方接口 | 本机 B站 登录凭据 |
| 2 | `ytdlp` | B站 上直接跳过；别的站让下载器先列站上自带的字幕，人工的优先、站上自动生成的其次 | 视频站自己（经由下载器） | 无（要登录才给看的站如实说清，不替你登录） |
| 3 | `whisper` | 本机 Whisper 引擎转字幕（B站 走 playurl 音频、别的站走下载器的音轨 → Python 转写 → SRT） | 无 | 无 |
| 4 | `local` | 本机 SenseVoice 引擎转字幕（三样零件在设置页一键装齐，不需要 Python） | 无 | 无 |

整条链只碰 B站 官方接口、视频站自己、与本机：没有第三方站点，包里也没有任何他人代码（下载器是用户点一个按钮装到插件自己目录里的一个独立程序，不是仓库里的依赖）。

- `native` 是**主力源**：B站 的官方 AI 字幕轨要「已登录 + WBI 签名」才返回 `subtitle_url`，匿名一律拿不到（实测 27 个视频：匿名 0 个有轨，登录后 23 个有轨）。
- 要到登录状态有两条路，**先用第一条**：一是到设置里的「视频字幕」页点扫码登录，用手机 B站 扫一下，凭据自动存进 `<DSH_HOME>/video-subtitle/bili-login.json`；二是老用户已经在用的 `<DSH_HOME>/bili-duty/bili_credential.json`，插件照样认，只是兼容用的，不算主路。也可以在 `biliCookie` 里直接写一整条 Cookie 串应急。
- 拿到登录凭据后，插件先按匿名方式试一次（公开字幕轨照样能拿），没轨再按 B站 的 WBI 规则给参数签名后重新要一次。实测常规视频 0.5~1.4 秒返回、覆盖 100%。凭据只在本机内存里用，不打印、不写回、不上传；`subtitle_providers` 里只显示读的是哪个文件。
- `whisper` 是备用本机源：匿名取 playurl 的 dash 音频 → 本机 Python（faster-whisper，CPU int8）转写 → SRT。**不依赖任何外部服务、没有次数限制、任何有声音的视频都能转**。音频由 PyAV 直接解码，不需要 ffmpeg。
- `whisper` 的零件不用自己装：在设置里的「视频字幕」页点「一键安装」，它会建好 Python 虚拟环境、装 faster-whisper、下好模型，装在 `<DSH_HOME>/video-subtitle/asr` 下，装的过程中每一步的进度都显示在页面上。本机已经有一套老的 `<DSH_HOME>/bili-duty/.venv-asr` 加 `.hf-cache` 时直接接着用，不逼人重装。想自己指定位置就填 `whisperPython` / `whisperHfHome`，填了听填的。
- `whisper` 的代价是慢，但已经比原来快一截：默认打开批处理（`whisperBatchSize` 默认 8）并取词级时间戳，再按标点或 `whisperMaxChars`（默认 24 字）重新切成短条目。实测 180 秒音频从 22.5 秒降到 17.9 秒（约 1.25 倍）、条目从 54 段细化到 61 段平均 3.03 秒；1494 秒整段 130.9 秒，约 11 倍实时，30 分钟视频约 2 分半。批处理不可用时自动退回逐段转写，结果一样能用。所以它的超时上限单独按 `whisperTimeoutMs`（默认 30 分钟）算，不跟别的源共用 90 秒；工具总等待上限也自动把它算进去。
- `whisper` 转写完整段音频，结果标记 `fullAudioProcessed: true`；语种由模型自己判断，写进轨道的 `lang`。转写进程是常驻的：模型只在第一次用到时加载一次，后面连着取多条直接接着用，不用每条都重新加载（实测三条视频 48.4 秒，改成每条新开进程时 52.7 秒）。想排除常驻本身的问题，把 `whisperReuseModel` 设成 `false` 就是每条新开一个进程。
- `whisper` 会先对一次账：B站 匿名 playurl 对一部分视频**只给试看片段**（实测某 72 分钟视频只给 616 秒音频），`dash.duration` 会如实标出片段长度。音频比视频短 5% 以上时直接报 `AUDIO_TRUNCATED`，不去转那一小段冒充整片。这类视频登录也不一定能解（实测同一账号：43 分钟的给了完整音频，72 分钟的仍只有 616 秒），属于 B站 侧限制。
- `local` 是另一条本机路线，用的是 SenseVoice 引擎（`whisper` 用的是 Whisper 引擎，两个是不同的开源语音转文字引擎，不是同一个功能说两遍）。同样是本机自己认字、不联网、不限次数。它比 `whisper` 快，但要多装三样东西：FFmpeg（从视频里抽出声音）、SenseVoice 模型（约 239 兆）、SenseVoice 模型词表，加起来约二百六十兆。这三样在设置里的「视频字幕」页点一次「一键安装」就装齐，全程**不需要 Python**，也不要求先装别的软件。装的位置是 `<DSH_HOME>/video-subtitle/local`（工具在 `bin/`，模型和词表在 `models/sensevoice-onnx/`），装在插件自己的目录里，不碰系统。下载能看进度、能取消；取消或断网后已经下了一半的文件留着，下次点安装接着下，不从头来。
- `local` 装在 `whisper` 后面当第二条本机路线：两个都装好也不冲突，`whisper` 先试，它拿不到结果时再轮到 `local`。要用哪条、谁先谁后，改 `providerOrder` 就是。四个路径项（`ffmpegPath` / `sherpaAddonPath` / `senseVoiceModel` / `senseVoiceTokens`）留空就用一键安装装好的位置，留空且还没装过时会退到老位置自动查找。
- `ytdlp` 是「站上现成字幕」这条路：B站 上它自己跳过（B站 走官方接口更快更全，实测拿下载器去取 B站 官方字幕反而拿不到，插件自己一秒就拿到了），只有「不是 B站」时才交给它。它先列站上有没有现成字幕，人工的优先，其次站上自动生成的；要的语种没有就取视频原文语种那条。拿到的字幕一律转成标准 SRT 再往下走，所以写盘、缓存、按区间读、整理成通稿这几步完全不分平台。站上真的一条字幕都没有，就交给后面的本机转写：B站 的音频走 playurl，别的站的音频由下载器取下来（这条分支写在 `lib/audio.js`），转写那一段两边一模一样。
- 下载器不装也不耽误 B站：它没装时 `ytdlp` 只会说「还没装下载器」，B站 那条路一步都不多等。装它在设置里的「视频字幕」页，卡片叫「B站 以外的站用的下载器」，点一次「一键安装」就行（十几兆，能看进度、能取消、断了接着下），装在 `<DSH_HOME>/video-subtitle/ytdlp`。装完会真的跑一次 `--version` 复查，版本对得上才算装好。
- 整张播放列表、整个频道不展开：一次只处理给的那一条链接，回执里会说明只取了这一条。要登录才给看的站如实说清是哪一种，不替你登录，也不假装取到了。
- WBI 签名规则与 key 缓存写在 `lib/wbi.js`（key 从 `/x/web-interface/nav` 现取，缓存 1 小时）；登录凭据读取与字段映射写在 `lib/bili-credential.js`，按文件修改时间缓存，只说明凭据是从哪个文件读到的、登录名是谁，不报缺了哪个次要字段（`buvid3` 这类字段缺了也不影响取官方字幕，实测加不加返回的轨完全一样）。找凭据的顺序是：配置里写死的 Cookie → 配置里指定的文件 → 设置页扫码登录存下的文件 → 旧的 bili-duty 凭据文件，先找到先用。B站 换签名规则时只改 `lib/wbi.js`。
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
providerOrder: ['native', 'ytdlp', 'whisper', 'local']
saveDir: ''                  # 固定目录；空 = 交给 saveToWorkspace 策略
saveToWorkspace: true        # true = 写进发起调用的那个会话自己的工作区（每次调用实时解析）
workspaceSubdir: '.subtitles' # 会话工作区里的子目录名；写文件时自动创建
preferLang: ['zh', 'en']
timeoutMs: 90000             # 单个 provider 的超时；工具总等待上限 = 30 秒取视频信息 + 每个启用的源各一份 + 15 秒写文件余量
whisperPython: ''            # 留空 = 用设置页一键安装的位置 <DSH_HOME>/video-subtitle/asr/venv/Scripts/python.exe；本机已有旧的 bili-duty 那套就接着用
whisperHfHome: ''            # 留空 = 用 <DSH_HOME>/video-subtitle/asr/hf-cache；本机已有旧的 bili-duty 那套就接着用
whisperTmpDir: ''            # 转写临时文件目录；留空跟着实际用的 Python 走（复用旧环境时用旧环境旁边的 tmp）
whisperModel: small          # faster-whisper 模型名（已缓存的：small）
whisperThreads: 4
whisperBatchSize: 8          # 批处理一次喂几段音频；实测比逐段快约 1.25 倍，0 = 关掉
whisperMaxChars: 24          # 词级时间戳按多少字收一条；越小越细碎
whisperLang: auto            # auto = 让模型判断；也可写 zh / en / ja
whisperTimeoutMs: 1800000    # 单个视频转写的时间上限（毫秒，默认 30 分钟）
whisperMaxMinutes: 180       # 超过这个时长的视频不做本地转写
whisperReuseModel: true      # 转写进程常驻复用，模型只加载一次；false = 每条新开进程（排障对比用）
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
ytdlpPath: ''                 # 别的站要用的下载器；留空 = 用设置页一键安装装到 <DSH_HOME>/video-subtitle/ytdlp 的那份
```

上面这份是给命令行用户看的默认值。普通人不用改它：设置里的「视频字幕」页能改八项——`preferLang`（auto / zh / en）、`saveToWorkspace`、`workspaceSubdir`、`saveDir`、`cacheTtlDays`、`fullCoveragePct`、`whisperModel`、`whisperBatchSize`。在页面上改完的值写进 `<DSH_HOME>/video-subtitle/settings.json`，读的时候盖在这份 YAML 上面，所以以页面为准；每次取字幕都重新读这个文件，改完立刻生效，不用重启。

## 服务端接口

设置页那一半不能直接读服务器上的文件，所以插件在 `/api/video-subtitle` 下开了几个接口，只用来报状态、扫码登录、装两条本机路线缺的零件与下载器、读写设置。字幕正文一律不经过这些接口。

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/video-subtitle/status` | GET | 一次报齐：登录状态（带 `expired` 标记，说清是「没登录过」还是「登录过但凭据不管用了」）、Whisper 那套的四步体检、SenseVoice 那三样零件的体检、下载器装没装、几个字幕源的状况、当前设置、几处目录、安装提示 |
| `/api/video-subtitle/login/qr` | GET | 生成登录二维码，回二维码标识、SVG 图和过期时间 |
| `/api/video-subtitle/login/poll` | GET | 拿二维码标识查扫码结果；成功时顺手把凭据存好 |
| `/api/video-subtitle/login/logout` | POST | 退出登录：把扫码登录存的凭据、旧的历史凭据文件、配置里指定的凭据文件一起删掉，回一句说清了删了几处的话 |
| `/api/video-subtitle/asr/setup` | POST | 开始装 Whisper 那套装的东西，立刻返回任务号 |
| `/api/video-subtitle/asr/state` | GET | 读安装进度：当前第几步、每步状态、日志 |
| `/api/video-subtitle/asr/cancel` | POST | 停掉正在跑的安装 |
| `/api/video-subtitle/asr/hint` | GET | 给出这台机器上缺什么、该敲哪条命令手动装 |
| `/api/video-subtitle/local/setup` | POST | 开始装 SenseVoice 那三样零件，立刻返回任务号 |
| `/api/video-subtitle/local/state` | GET | 读安装进度：当前第几步、每步状态、下载到百分之几、日志 |
| `/api/video-subtitle/local/cancel` | POST | 停掉正在跑的安装，下了一半的文件留着下次接着下 |
| `/api/video-subtitle/ytdlp/setup` | POST | 开始装别的站要用的下载器，立刻返回任务号 |
| `/api/video-subtitle/ytdlp/state` | GET | 读下载器的安装进度：当前第几步、下载到百分之几、日志 |
| `/api/video-subtitle/ytdlp/cancel` | POST | 停掉下载器的安装，下了一半的文件留着下次接着下 |
| `/api/video-subtitle/settings` | POST | 保存设置页改的那几项 |

## 文件布局

```
lib/index.js                name/inject/Config/apply + 五个工具注册 + 系统提示段落
lib/client.js               设置页那一半界面：扫码登录、装两条本机路线缺的零件、改设置
lib/api.js                  /api/video-subtitle 下那几个接口，给设置页取数据和下命令
lib/settings.js             设置页改的那八项，读写 <DSH_HOME>/video-subtitle/settings.json
lib/bili-login.js           扫码登录：要二维码、查扫码结果、校验账号、存凭据
lib/qr.js                   自己算二维码点阵，不依赖第三方二维码包
lib/asr-env.js              Whisper 那套装在哪个目录、缺什么、一键安装
lib/local-env.js            SenseVoice 那三样零件装在哪个目录、缺什么、一键安装（不需要 Python）
lib/ytdlp-env.js            别的站要用的下载器装在哪个目录、缺什么、一键安装
lib/ytdlp.js                只管跑下载器：列语种、下字幕、下音轨、把它的报错翻成错误码
lib/audio.js                声音从哪来：B站 走 playurl，别的站走下载器，两条本机转写共用
cordis.patch.yml            dsh.bundle.patch 指向；默认配置
locale/zh.json              设置页显示的中文名与说明
locale/en.json              英文名与说明
icon.svg                    设置页图标（原创）
test/*.test.js              自动测试（node --test，215 项）
lib/pipeline.js             provider 链调度、缓存、写文件、read/status/polish
lib/ids.js                  URL/BV/av/b23.tv/分P 解析、view 接口取 cid
lib/srt.js                  utterances→SRT、容错解析、区间切片、语种比对
lib/wbi.js                  B站 WBI 签名（mixinKey、w_rid、key 缓存）
lib/bili-credential.js      本机登录凭据读取与字段映射，以及退出登录时按来源逐个删干净
lib/batch.js                批量/合集分P展开与逐条抓取
lib/text-format.js          碎片并句、补标点、纯文稿
lib/providers/native.js     官方字幕轨（匿名 + 登录签名）
lib/providers/whisper.js    本机 faster-whisper 转写（批处理 + 词级切条）
lib/providers/local.js      本机 SenseVoice 转写（ffmpeg 异步解码 + sherpa-onnx 识别）
lib/providers/ytdlp.js      站上现成字幕（B站 跳过，别的站人工优先、其次站上自动生成）
```

## 跑测试

```
npm test
```

215 项自动测试：编号解析（BV/av/分P/短链/别站误吃、别的站原样留网址）、字幕解析与时间轴校验、区间读取与超长单句截断、语种按整词比对、等待上限随源数量变化（含 whisper 单独留出转写时间）、本地源缺件说明、子进程超时/取消/并行、WBI 签名（key 提取、mixinKey 重排、w_rid 等于 query 拼 key 的 md5、参数顺序无关、五个字符剥离）、native 的四种身份组合（匿名有轨/匿名无轨转签名/无凭据/凭据过期）与坏轨跳过、批量解析与逐条容错、碎片并句与补标点、词级切条，以及这次新加的几块：扫码登录（二维码地址与过期时间、五种扫码状态、Cookie 拼接、成功与失败时的错误文字都不许带凭据）、二维码逐格比对（自己算的点阵跟参照包比、格式信息与版本信息写对、四种纠错等级）、Whisper 四步体检（运行环境/程序本体/模型/临时文件夹，老环境复用与正式位置、装到一半失败、同一时间只跑一个任务、日志里抹掉用户名与 token）、转写临时目录跟着实际用的解释器走（复用的老环境用它旁边的 tmp，首选建不了就一路退到备用目录，全建不了时报错里写清试过哪些地方）、批量与设置页那几块、退出登录（场景是只剩旧凭据文件时也必须真的退出、配置里写死的 Cookie 删不掉要说明、重复点退出不报错）、登录状态分得清三种（凭据过期要标出来并说重新扫一次、从来没登录过不许标成过期、校验时连不上 B站 只说查不了不催人重扫）、设置页把该先做的那张卡片挑出来高亮（没登录先引导登录、登录后没装好转写环境就引导去装）、失败回执的下一步指引（未登录、登录过期、转写跑挂、只给试看片段、残片被拦各说什么，最多三条且不许重复，什么线索都没有时也给一句能照着做的话），常驻转写进程（连跑三条只启动一次、崩了自动重开、卡住按超时换掉、关掉复用就每条新开、插件退出时能收掉），SenseVoice 那三样零件的一键安装（四个步骤的名字固定、装好的那步标成跳过、半截文件用续传接着下、服务器说已经下满时不再白下第二遍、安装包跳转后能下到并把 exe 解出来、装错了包要明确报错、网络失败自动重试、一直失败说清是哪一样没下来、取消时真把请求掐断、已经在跑时不会开第二个任务、文件只有一小截不算装好）、可选的字幕来源在状态里带标记、别的站那整条路（下载器的安装与体检：镜像失败改走官方地址、半截文件续传、取消真掐断请求、装完跑一次版本复查、日志抹掉用户目录与带签名的地址；跑下载器那一层：清单解析成人话、人工与自动字幕分开、报错翻成三种错误码、下字幕参数齐全、下音轨拿到路径；来源链那一层：B站 立刻跳过、下载器没装就说清去哪装、站上一条字幕都没有才报没有、人工优先、要的语种没有就取原文语种、洗掉尖括号标签与重复条目、处理完临时目录删干净），以及插件清单本身（声明了客户端一半、指向的文件真实存在、客户端里除了平台的 react 不许有别的依赖、版本号只写在清单一处）。自动测试全部用假的网络请求与假程序跑，不联网、不下载任何真实文件。

写出来的文件名：`<视频编号>[-pN].<lang>.<provider>.srt`，同目录另写 `<视频编号>.meta.json`（本次 provider 链逐项结果）。B站 的编号是 bvid，别的站用站上那个视频自己的编号，命名规则不分平台。

## 站点改版时改哪里

| 变化 | 改这里 |
|---|---|
| B站 换接口 | `lib/providers/native.js` / `lib/providers/whisper.js` |
| B站 换签名规则 | `lib/wbi.js`（只改这个文件，两个源共用） |
| 登录凭据换位置/换格式 | `cordis.patch.yml` 的 `biliCredentialFile`，或改 `lib/bili-credential.js` 的字段映射 |
| 扫码登录相关的官方接口变了 | `lib/bili-login.js`（要二维码、查结果、校验账号都在这一个文件里） |
| 设置页界面要加东西 | `lib/client.js` 画页面、`lib/api.js` 加接口、`lib/settings.js` 加能改的字段 |
| Whisper 那套的安装步骤变了 | `lib/asr-env.js` 的 `STEPS` 四步 |
| SenseVoice 那三样零件的下载地址或大小变了 | `lib/local-env.js` 顶部那几个常量（模型字节数、词表字节数、wheel 源与直链、镜像根） |
| 下载器的下载地址变了 | `lib/ytdlp-env.js` 顶部的 `MIRROR_URL` 与 `OFFICIAL_URL` |
| 某个站要单独处理（例如它要登录） | 先看下载器认不认这个站；它认就什么都不用改，它不认时按它的说法如实报，不自己写这个站的解析规则 |

## 不做什么

不接第三方字幕站：试过一家，每天只放两次成功解析、常年解析失败，加密实现还得照抄对方网页代码，已整站移除。字幕来源只有三种：B站 官方接口、站上自己带的字幕、本机转写。

不写站点的解析规则：B站 自己写，因为它要登录加签名、插件一秒就能拿到；别的站一律交给那个现成的下载器，不自己维护一千多个站的规则，也不引第二个外部程序。

不碰浏览器（不读浏览器里存的 Cookie、不打开浏览器），但提供 B站 官方的扫码登录；不给别的站的账号做登录（要登录才给看的站如实说清）；不展开整张播放列表与整个频道；不下载视频本体（只要声音和字幕）；不抓弹幕/评论/封面；不做总结（总结是模型的事）；除字幕源外不外传任何数据。

登录凭据是唯一的例外：`native` 需要它才能拿到官方 AI 字幕轨。在设置页扫码登录成功后，凭据存在 `<DSH_HOME>/video-subtitle/bili-login.json`；老用户的 `<DSH_HOME>/bili-duty/bili_credential.json` 也兼容。每次取字幕只把这份凭据读进内存、拼进请求头，不打印、不写回、不写进任何输出文件，`subtitle_providers` 与出错信息里也只写读的是哪个文件、缺哪个字段。
