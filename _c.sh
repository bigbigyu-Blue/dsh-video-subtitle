set -e
cd "/d/软件开发/DSH字幕下载插件"
export TMP="/d/软件开发/DSH字幕下载插件/_tmp"
export TEMP="/d/软件开发/DSH字幕下载插件/_tmp"
mkdir -p "$TMP"
export HTTPS_PROXY=http://127.0.0.1:7890
git add -A
git -c user.name="bigbigyu" -c user.email="bigbigyu@users.noreply.github.com" commit -m "0.6.1：退出登录真的能退出，并且把结果说清楚" -m "原来点退出登录只删扫码登录存的那一份凭据，只剩旧的历史凭据文件时点了没反应。现在把三个来源的凭据文件都删掉，删了几处、哪一处删不掉、配置里写死的 Cookie 删不掉，都在界面上用一句话说明。补了 8 项自动测试。"
git -c credential.helper='!gh auth git-credential' push origin master 2>&1 | tail -5
rm -rf "$TMP"
git log --oneline -2
