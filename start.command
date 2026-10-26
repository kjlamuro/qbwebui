#!/bin/bash
# 双击启动 qBWebUI —— 后台运行，启动后本窗口可直接关闭
#
# 几个容易踩的坑，这里都已经处理：
#   1. 旧版把 node 放前台，关窗口发 SIGHUP 会把服务带走，且不留任何日志。
#   2. nohup 对 Node 无效——Node 启动时会重置信号处理，覆盖 nohup 的 SIGHUP 忽略。
#      真正挡住关窗口的是 server.mjs 里注册的 SIGHUP 处理。
#   3. 连点两下会并发启动、互相撞端口，所以用原子文件锁串行化。
#      锁用「文件」而非「目录」：rmdir 在部分环境（受限权限/沙箱）会失败，
#      残留的空目录会挡住后续所有启动；rm -f 则可靠得多。
set -u

cd "$(dirname "$0")" || exit 1

# Finder 双击给的是最小 PATH，常缺 Homebrew / nvm 的路径
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.workbuddy/binaries/node/versions/*/bin; do
    [ -x "$d/node" ] && export PATH="$d:$PATH" && break
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js，请先安装：https://nodejs.org"
  read -r -p "按回车键退出..."
  exit 1
fi

# 端口：优先取环境变量 PORT，其次配置文件，最后默认 7788
if [ -z "${PORT:-}" ]; then
  PORT=$(node -e 'try{const c=require("./config.json");process.stdout.write(String(c.port||7788))}catch(e){process.stdout.write("7788")}' 2>/dev/null)
  [ -n "$PORT" ] || PORT=7788
fi

URL="http://127.0.0.1:${PORT}"
LOGDIR="${QBWEBUI_LOGDIR:-$HOME/Library/Logs}"
LOG="$LOGDIR/qbwebui.log"
PIDFILE="$LOGDIR/qbwebui-${PORT}.pid"
LOCKFILE="$LOGDIR/qbwebui-${PORT}.lock"

# 线程池从默认的 4 调到 8：fs 和 DNS 共用它，外置盘掉速时单个卡住的 open()
# 会把 4 个线程全拖住，连静态文件都发不出去。调大只是降低被整锅端掉的概率，
# 真正的兜底是 server.mjs 里的看门狗。
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}"

# 看门狗发现线程池卡死时会自己 spawn 一个接班人。告诉它日志写到同一个文件，
# 否则接班进程的输出会跑到默认位置，出问题两头找日志。
export QBWEBUI_LOG="${QBWEBUI_LOG:-$LOG}"

port_busy() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }
open_ui() { [ "${QBWEBUI_NO_OPEN:-}" = "1" ] || open "$URL" 2>/dev/null; }

# 原子抢锁：noclobber 下 > 重定向对已存在文件会失败，可当 CAS 用
try_lock() { ( set -o noclobber; echo $$ > "$LOCKFILE" ) 2>/dev/null; }
release_lock() {
  [ "$(cat "$LOCKFILE" 2>/dev/null)" = "$$" ] && rm -f "$LOCKFILE" 2>/dev/null
}

mkdir -p "$LOGDIR"

# 已经在跑就只开浏览器，不重复启动
if port_busy; then
  echo "qBWebUI 已在运行：$URL"
  echo "如需重启，先双击 stop.command"
  open_ui
  exit 0
fi

LOCKED=""
for _ in $(seq 1 40); do   # 最多等待约 10 秒
  if try_lock; then
    LOCKED=1
    break
  fi
  # 锁被持有：若端口已通，说明对方已经启动成功，本实例无需再启动
  if port_busy; then
    echo "qBWebUI 已在运行：$URL"
    open_ui
    exit 0
  fi
  HOLDER=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "$HOLDER" ] && ! kill -0 "$HOLDER" 2>/dev/null; then
    # 持锁进程已消失（上次异常退出留下的死锁）
    rm -f "$LOCKFILE" 2>/dev/null
    continue
  fi
  if [ -z "$HOLDER" ]; then
    # 锁文件内容为空/损坏（写到一半被杀）。刚创建存在「还没写入」的毫秒级窗口，
    # 所以按锁龄判断，超过 5 秒才当残骸清掉。
    NOW=$(date +%s)
    MT=$(stat -f %m "$LOCKFILE" 2>/dev/null || echo "$NOW")
    if [ $((NOW - MT)) -ge 5 ]; then
      rm -f "$LOCKFILE" 2>/dev/null
      continue
    fi
  fi
  sleep 0.25
done

# 等待超时：若确认端口空闲，说明只是残骸挡路，强制接管
if [ -z "$LOCKED" ]; then
  if port_busy; then
    echo "qBWebUI 已在运行：$URL"
    open_ui
    exit 0
  fi
  rm -f "$LOCKFILE" 2>/dev/null
  if try_lock; then
    LOCKED=1
    echo "清理了残留的启动锁，继续启动..."
  fi
fi

if [ -z "$LOCKED" ]; then
  echo "等待超时：另一次启动似乎仍在进行中。"
  echo "若确认没有服务在跑，删掉锁文件后重试：$LOCKFILE"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

# 无论正常退出还是被中断，都释放锁（只释放自己持有的）
trap release_lock EXIT INT TERM

# 日志超过 5MB 就滚动一份，避免无限增长
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv -f "$LOG" "$LOG.1"
fi

echo "使用 Node: $(command -v node) ($(node -v))"
echo "正在启动..."

# nohup 忽略 SIGHUP、</dev/null 断开终端输入、disown 从任务表摘除
nohup node server.mjs >>"$LOG" 2>&1 </dev/null &
PID=$!
disown "$PID" 2>/dev/null || true

# 轮询等待：必须先确认「自己启动的进程」还活着，再看端口通没通。
# 顺序不能反——否则并发时对方占着端口，会让本实例误判成功、写进一个死 PID。
for _ in $(seq 1 30); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo
    if port_busy; then
      echo "启动失败：端口 ${PORT} 已被其它进程占用。"
    else
      echo "启动失败，进程已退出。"
    fi
    echo "日志最后 20 行："
    tail -20 "$LOG"
    echo
    read -r -p "按回车键关闭窗口..."
    exit 1
  fi
  if port_busy; then
    # 确认成功后才写 pid 文件，避免写入一个已死的 PID
    echo "$PID" > "$PIDFILE"
    echo
    echo "qBWebUI 已后台启动"
    echo "  访问  $URL"
    echo "  PID   $PID"
    echo "  日志  $LOG"
    echo "  停止  双击 stop.command"
    echo
    echo "本窗口现在可以直接关闭，服务会继续运行。"
    sleep 1
    open_ui
    exit 0
  fi
  sleep 0.2
done

echo "启动超时，请查看日志：$LOG"
read -r -p "按回车键关闭窗口..."
exit 1
