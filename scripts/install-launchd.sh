#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${VAULT_LAUNCHD_LABEL:-$(cat "$ROOT/deploy/launchd-label.local" 2>/dev/null || printf '%s' 'local.douyinvault')}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
UID_VALUE="$(id -u)"

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing $ROOT/.env. Copy .env.example and configure it first." >&2
  exit 1
fi
if grep -qE '^[[:space:]]*IM_ADAPTER[[:space:]]*=[[:space:]]*mock([[:space:]]|$)' "$ROOT/.env"; then
  echo "Refusing to install production LaunchAgent with IM_ADAPTER=mock." >&2
  echo "Set IM_ADAPTER=douyin-im (or playwright after validation) in .env first." >&2
  exit 1
fi
if [ ! -f "$ROOT/apps/server/dist/main.js" ] || [ ! -f "$ROOT/apps/web/dist/index.html" ]; then
  echo "Build not found. Run: pnpm install && pnpm build" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data/logs"
chmod 700 "$ROOT/data" "$ROOT/data/logs" 2>/dev/null || true
chmod +x "$ROOT/scripts/run-server.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/scripts/run-server.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>NODE_BIN</key>
    <string>$NODE_BIN</string>
    <key>PATH</key>
    <string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LANG</key>
    <string>zh_CN.UTF-8</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$ROOT/data/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/data/logs/launchd.err.log</string>
</dict>
</plist>
EOF

chmod 600 "$PLIST"
launchctl bootout "gui/$UID_VALUE" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
launchctl enable "gui/$UID_VALUE/$LABEL"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"

echo "Installed and started LaunchAgent: $LABEL"
echo "Plist: $PLIST"
echo "Logs:  $ROOT/data/logs/launchd.{out,err}.log"
echo "The service starts when this macOS user logs in. For boot-without-login, use a LaunchDaemon after validating IM/login behavior."
