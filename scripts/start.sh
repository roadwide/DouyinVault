#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${VAULT_LAUNCHD_LABEL:-$(cat "$ROOT/deploy/launchd-label.local" 2>/dev/null || printf '%s' 'local.douyinvault')}"
UID_VALUE="$(id -u)"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$PLIST" ]; then
  if launchctl print "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$UID_VALUE/$LABEL"
    echo "Restarted $LABEL"
  else
    launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
    launchctl kickstart -k "gui/$UID_VALUE/$LABEL"
    echo "Started $LABEL"
  fi
  exit 0
fi

cd "$ROOT"
mkdir -p data/logs
nohup "$ROOT/scripts/run-server.sh" >> data/logs/manual.out.log 2>&1 &
echo $! > data/server.pid
echo "Started manually. PID $(cat data/server.pid), log data/logs/manual.out.log"
