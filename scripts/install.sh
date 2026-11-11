#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5+ is required." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install with: npm install -g pnpm@10" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg and ffprobe are required. Install them first (brew install ffmpeg)." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example. Edit it before starting production."
fi

pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate

echo ""
echo "Install complete."
echo "Next:"
echo "  1. Edit .env (IM_ADAPTER, PUBLIC_ORIGIN, download API settings)."
echo "  2. Start in foreground: pnpm start"
echo "  3. First-run setup:      pnpm setup-token"
echo "  4. Background install:   bash scripts/install-launchd.sh"
echo ""

if [ "${1:-}" = "--launchd" ]; then
  if grep -qE '^[[:space:]]*IM_ADAPTER[[:space:]]*=[[:space:]]*mock([[:space:]]|$)' .env; then
    echo "IM_ADAPTER is still mock. Real production requires douyin-im and Phase 0 validation." >&2
    exit 1
  fi
  bash scripts/install-launchd.sh
fi
