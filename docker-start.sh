#!/bin/sh
set -e

# 动态定位 server.js 并启动
# Next.js standalone 保留构建时 WORKDIR 路径，如 /next-standalone/app/server.js
SERVER_JS=$(find /next-standalone -name "server.js" -type f | head -1)

if [ -z "$SERVER_JS" ]; then
  echo "ERROR: server.js not found!"
  find /next-standalone -type f | head -30
  exit 1
fi

SERVER_DIR=$(dirname "$SERVER_JS")
echo "[start] Found server.js at: $SERVER_JS"
echo "[start] Working directory: $SERVER_DIR"
echo "[start] PORT=$PORT HOSTNAME=$HOSTNAME"

cd "$SERVER_DIR"
exec node server.js
