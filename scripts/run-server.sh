#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f "apps/server/dist/main.js" ]; then
  echo "Server build not found. Run: pnpm install && pnpm build" >&2
  exit 1
fi

mkdir -p data/logs
exec "${NODE_BIN:-node}" apps/server/dist/main.js
