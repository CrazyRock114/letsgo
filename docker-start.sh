#!/bin/bash
set -e

echo "=== 小围棋乐园 启动 ==="

echo "[app] 启动服务器..."
exec node server.js
