#!/data/data/com.dsharnessmobile.shell/files/usr/bin/bash
# Pi X — Termux quickstart (dev path, no bundled runtime yet)
#
# Gives you a REAL local pi engine on the phone today:
#   App (localhost:8765) <-> pi-host (this script) <-> pi --mode rpc
#
# Usage:  bash scripts/termux-setup.sh
set -euo pipefail

echo "==> [1/5] Updating packages"
pkg update -y && pkg upgrade -y

echo "==> [2/5] Installing Node + tools"
pkg install -y nodejs-lts git ripgrep

echo "==> [3/5] Installing pi engine (official Termux path)"
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

echo "==> [4/5] Verify engine"
pi --version
printf '{"type":"get_state","id":"t1"}\n' | PI_OFFLINE=1 pi --mode rpc --no-session | head -c 200
echo
echo "==> [5/5] Ready"
echo "Run the host:"
echo "  git clone https://github.com/heikeyangle-code/pi-x ~/pi-x && cd ~/pi-x"
echo "  npm ci && cd packages/bridge && npx tsc -p tsconfig.json && cd ../.."
echo "  PI_HOST=1 PI_ENGINE_ENTRY=\$(command -v pi) PI_ENGINE_VERSION=\$(pi --version) BRIDGE_PORT=8765 node packages/bridge/dist/pi-host-entry.js"
echo "Then point the App at ws://127.0.0.1:8765 (local engine, already seeded)."
