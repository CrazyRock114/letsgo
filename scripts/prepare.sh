#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

# Auto-install KataGo if not present (compile from source + download model)
# This ensures KataGo is available after sandbox resets
# GnuGo is bundled in bin/gnugo and doesn't need re-installation
if [ ! -x /usr/local/katago/katago ]; then
  echo "KataGo not found, running auto-install (may take 2-3 minutes)..."
  bash "${COZE_WORKSPACE_PATH}/scripts/install-katago.sh" || echo "KataGo install failed, will use GnuGo/local AI fallback"
else
  echo "KataGo already installed"
fi
