#!/bin/bash
# 双击停止 qBWebUI
#
# pid 文件可能已经过期（进程被外部杀掉时不会自动清理），这里不盲信：
# 先按 pid 文件找，并验明正身；对不上就按端口上真实监听的进程来停。
set -u

cd "$(dirname "$0")" || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.workbuddy/binaries/node/versions/*/bin; do
    [ -x "$d/node" ] && export PATH="$d:$PATH" && break
  done
fi

if [ -z "${PORT:-}" ]; then
  if command -v node >/dev/null 2>&1; then
    PORT=$(node -e 'try{const c=require("./config.json");process.stdout.write(String(c.port||7788))}catch(e){process.stdout.write("7788")}' 2>/dev/null)
  fi
  [ -n "${PORT:-}" ] || PORT=7788
fi

LOGDIR="${QBWEBUI_LOGDIR:-$HOME/Library/Logs}"
PIDFILE="$LOGDIR/qbwebui-${PORT}.pid"
LOCKFILE="$LOGDIR/qbwebui-${PORT}.lock"
LABEL="com.kjlamuro.qbwebui"

# 清掉启动锁：上次异常退出留下的死锁会挡住下次启动
rm -f "$LOCKFILE" 2>/dev/null

# 被 launchd 托管时，kill 掉会被立刻重启，得走 bootout。
# 只在该服务管理的端口与本脚本目标端口一致时才拦截——否则停测试/临时端口会被误伤。
CFGPORT=""
if command -v node >/dev/null 2>&1; then
  CFGPORT=$(node -e 'try{const c=require("./config.json");process.stdout.write(String(c.port||7788))}catch(e){process.stdout.write("7788")}' 2>/dev/null)
fi
[ -n "$CFGPORT" ] || CFGPORT=7788

if [ "$PORT" = "$CFGPORT" ] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "qBWebUI 正由 launchd 托管，kill 会被自动重启。"
  echo "请改用：launchctl bootout gui/$(id -u)/$LABEL"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

PID=""
if [ -f "$PIDFILE" ]; then
  CAND=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$CAND" ] && kill -0 "$CAND" 2>/dev/null; then
    # 确认这个 PID 确实是本项目的 server.mjs，避免误杀复用了该 PID 的其它进程
    if ps -p "$CAND" -o command= 2>/dev/null | grep -q "server.mjs"; then
      PID="$CAND"
    fi
  fi
fi

# pid 文件不可信时，按端口上真实监听的进程找
if [ -z "$PID" ]; then
  PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
fi

if [ -z "$PID" ]; then
  echo "qBWebUI 没有在运行（端口 $PORT 无监听）"
  rm -f "$PIDFILE"
  exit 0
fi

echo "正在停止 qBWebUI (PID $PID)..."
kill -TERM "$PID" 2>/dev/null

for _ in $(seq 1 25); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "已停止"
    exit 0
  fi
  sleep 0.2
done

echo "进程未响应，强制结束..."
kill -KILL "$PID" 2>/dev/null
sleep 0.5
if kill -0 "$PID" 2>/dev/null; then
  echo "停止失败，请手动处理 PID $PID"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

rm -f "$PIDFILE"
echo "已停止"
