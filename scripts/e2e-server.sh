#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

export DATA_DIR="${DATA_DIR:-.e2e-data}"
export PORT="${PORT:-18761}"
export HOST=127.0.0.1
export ADMIN_PASSWORD=e2e-password-123
export IM_ADAPTER=mock
export DEMO_MODE=true
export NODE_ENV=test
export LOG_PRETTY=false
export LOG_LEVEL=warn

rm -rf "$DATA_DIR"
pnpm demo:seed
exec node --import tsx apps/server/src/main.ts
