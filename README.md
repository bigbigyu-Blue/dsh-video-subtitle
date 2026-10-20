# dsh-video-subtitle

DeepSeek Harness 插件：把一个视频的字幕取成本地 .srt 文件。

B站 走插件自己写的官方接口；别的视频站交给免费开源的下载器 yt-dlp，先取站上现成的字幕，站上没有就把声音取下来交给本机转写。

## 安装

在命令行里执行：

```
dsh plugin --profile desktop add dsh-video-subtitle
```

装完退出桌面应用再重开一次，设置里才会出现「视频字幕」这一页。

也可以直接从仓库装，拿到的是最新一次提交：

```
dsh plugin --profile desktop add git+https://github.com/bigbigyu-Blue/dsh-video-subtitle.git
```

## 用起来

1. 打开设置里的「视频字幕」，点「扫码登录」，手机 B站 扫一下。不登录也能用，只是 B站 的官方字幕要登录才给地址。
2. 要取 B站 以外的视频，先点「下载器 yt-dlp」卡片上的「一键安装」，十几兆，几秒钟。
3. 回到对话里发一条视频链接，说「把这条视频的字幕取下来」。

字幕正文不会自动进入对话。取完只回标题、时长、字数、文件路径，要看内容再让它按时间区间读。

## 五个工具

| 工具 | 干什么 |
|---|---|
| `subtitle_fetch` | 取一个字幕，写成 .srt 文件 |
| `subtitle_read` | 按时间区间读已存的文件 |
| `subtitle_batch` | 一次取多条，或把整部合集的分P逐P取 |
| `subtitle_polish` | 把没标点的碎片拼成通顺句子，另出一份纯文稿 |
| `subtitle_providers` | 看四条来源各自缺什么、上次为什么失败 |

## 设置页

扫码登录、两条本机转写路线缺什么就一键装、装下载器、改常用设置，都在这一页。改完立刻生效，不用重启。

能改的八项：要哪种语言、存到当前工作区、工作区里的子目录、固定保存目录、缓存保留天数、完整度门槛、转写模型、批处理条数。

全部配置项与默认值在 `cordis.patch.yml`。

## 文件布局

```
lib/index.js          插件入口、五个工具注册
lib/pipeline.js       来源链调度、缓存、写盘、按需读取
lib/client.js         设置页界面
lib/api.js            设置页用的网页接口
lib/providers/        四条来源各自的实现
lib/ids.js            认链接
lib/srt.js            字幕格式
lib/batch.js          批量
lib/text-format.js    并句与补标点
test/                 自动测试
cordis.patch.yml      默认配置
locale/               中文与英文名称
icon.svg              设置页图标
```

## 跑测试

```
npm test
```

218 项，全部用假网络与假程序跑，不联网、不下载任何文件。

## 不做什么

- 不接第三方字幕站。字幕只从 B站 官方接口、视频站自己带的字幕、本机转写这三处来。
- 不替你登录要登录才给看的站。
- 不展开整张播放列表与整个频道，一次只处理给的那一条。
- 不改写字幕内容。整理句子只做拼接和补标点，一个原字都不动。

## 许可

MIT，见 `LICENSE`。
