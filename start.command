#!/bin/bash
# 双击启动 qBWebUI
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js，请先安装：https://nodejs.org"
  read -r -p "按回车键退出..."
  exit 1
fi

# 启动后自动打开浏览器
( sleep 1.2; open "http://127.0.0.1:7788" ) &

node server.mjs
