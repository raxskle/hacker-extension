#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/host.mjs"

if [ ! -f "$HOST_PATH" ]; then
  echo "[hacker-extension native-host] host script not found: $HOST_PATH" >&2
  exit 127
fi

# Native Messaging host is launched from browser process with a limited PATH.
# Expand to common Node.js install locations on macOS.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

for node_bin in "/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
  if [ -x "$node_bin" ]; then
    exec "$node_bin" "$HOST_PATH"
  fi
done

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$HOST_PATH"
fi

echo "[hacker-extension native-host] Node.js runtime not found in browser environment PATH." >&2
echo "[hacker-extension native-host] Tried: /opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node" >&2
echo "[hacker-extension native-host] Effective PATH: $PATH" >&2
echo "[hacker-extension native-host] Please install Node.js and reinstall host: npm run native:install:mac -- --extension-id=<your-extension-id>" >&2
exit 127
