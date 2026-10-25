#!/bin/bash
# 双击安装「开机自启 + 崩溃自动重启」的 launchd 服务
#
# 装好之后：终端窗口随便关、关闭 WorkBuddy 也不影响、开机自动起来、
# 进程崩了 10 秒内自动重启，日志写到 ~/Library/Logs/qbwebui.log。
#
# 卸载：launchctl bootout gui/$(id -u)/com.kjlamuro.qbwebui
set -u

cd "$(dirname "$0")" || exit 1

DIR="$(pwd)"
LABEL="com.kjlamuro.qbwebui"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/qbwebui.log"
ERRLOG="$HOME/Library/Logs/qbwebui.err.log"

# Finder 双击给的是最小 PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.workbuddy/binaries/node/versions/*/bin; do
    [ -x "$d/node" ] && export PATH="$d:$PATH" && break
  done
fi

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  echo "没找到 Node.js，请先安装：https://nodejs.org"
  read -r -p "按回车键退出..."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERRLOG</string>
</dict>
</plist>
PLIST_EOF

echo "配置已写入: $PLIST"
echo "Node: $NODE"
echo

if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
  echo "配置校验失败，已中止。"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

# 已装过就先卸掉，避免重复加载报错
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null

echo "正在加载服务..."
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1; then
  sleep 2
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo
    echo "安装成功。"
    echo "  访问  http://127.0.0.1:7788"
    echo "  日志  $LOG"
    echo "  卸载  launchctl bootout gui/\$(id -u)/$LABEL"
    echo
    echo "此后无需再双击 start.command，服务会随开机自动启动。"
  else
    echo "已提交加载，但服务未出现在列表中，请查看错误日志：$ERRLOG"
  fi
else
  echo
  echo "加载失败。常见原因："
  echo "  - 终端没有加载系统服务的权限，请在「系统设置 > 隐私与安全性」中允许终端"
  echo "  - 该服务已被其它方式加载，先执行：launchctl bootout gui/\$(id -u)/$LABEL"
  echo
  echo "若持续失败，可改用 start.command（后台模式，窗口可关，但崩溃不会自动重启）。"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

echo
read -r -p "按回车键关闭窗口..."
