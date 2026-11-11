#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${VAULT_LAUNCHD_LABEL:-$(cat "$ROOT/deploy/launchd-label.local" 2>/dev/null || printf '%s' 'local.douyinvault')}"
UID_VALUE="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$UID_VALUE" "$PLIST" 2>/dev/null || true
  echo "Stopped LaunchAgent $LABEL (it will start again at next login)."
  exit 0
fi

if [ -f "$ROOT/data/server.pid" ]; then
  PID="$(cat "$ROOT/data/server.pid")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Stopped PID $PID"
  fi
  rm -f "$ROOT/data/server.pid"
  exit 0
fi

pkill -f "apps/server/dist/main.js" 2>/dev/null || true
echo "Stopped any running Douyin Vault server process."
