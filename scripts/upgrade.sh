#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Backing up database"
pnpm backup

echo "==> Installing locked dependencies"
pnpm install --frozen-lockfile

echo "==> Building web and server"
pnpm build

echo "==> Stopping service before migrations"
bash scripts/stop.sh || true

echo "==> Applying database migrations"
pnpm db:migrate

echo "==> Starting service"
bash scripts/start.sh

echo "==> Health check"
HEALTH_OK=0
for _ in $(seq 1 10); do
  if pnpm healthcheck; then HEALTH_OK=1; break; fi
  sleep 2
done
if [ "$HEALTH_OK" != "1" ]; then
  echo "Health check failed. Inspect data/logs and the service before using it." >&2
  exit 1
fi

echo "Upgrade complete. Verify login, group status, and one manual download."
