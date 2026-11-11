#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${VAULT_LAUNCHD_LABEL:-$(cat "$ROOT/deploy/launchd-label.local" 2>/dev/null || printf '%s' 'local.douyinvault')}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE="$(id -u)"

launchctl bootout "gui/$UID_VALUE" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed LaunchAgent $LABEL. Data under data/ was not deleted."
