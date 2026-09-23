#!/usr/bin/env bash
# Linux port of start-local.ps1: builds the dashboard and API, then runs the
# single local process that serves both at http://127.0.0.1:3001.
set -euo pipefail

workspacePath="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$workspacePath"

# If a healthy WA Control server is already listening on 3001, do nothing:
# never fight another instance that is already serving the dashboard.
if curl -sf -m 2 http://127.0.0.1:3001/health >/dev/null 2>&1; then
  echo "WA Control is already running at http://127.0.0.1:3001"
  exit 0
fi

# A previous local copy can remain alive after an interrupted terminal. It is
# safe to replace a Node process on this app's fixed API port; do not touch a
# non-Node process that may belong to another application.
portPid="$(ss -tlnpH 2>/dev/null | sed -n 's/.*:3001 .*pid=\([0-9]*\).*/\1/p' | head -n1)"
if [ -n "$portPid" ]; then
  comm="$(ps -p "$portPid" -o comm= 2>/dev/null || true)"
  if [ "$comm" != "node" ]; then
    echo "Port 3001 is being used by $comm, not WA Control. Close that application first." >&2
    exit 1
  fi
  echo "Stopping the older WA Control service on port 3001..."
  kill "$portPid"
  sleep 1
fi

# Build the React dashboard without Vite's development server. This keeps the
# dashboard and API in one dependable local process at http://127.0.0.1:3001.
mkdir -p apps/web/dist/assets
./node_modules/.bin/esbuild apps/web/src/main.tsx \
  --bundle --format=esm --platform=browser --target=es2022 --jsx=automatic \
  "--outfile=apps/web/dist/assets/index.js" --loader:.tsx=tsx --loader:.css=css

# The compiled server serves web/dist/index.html at "/". The original
# PowerShell script never wrote this file (index.html still references the
# Vite dev entry), so write the compiled entry point here. The stylesheet link
# is required too: esbuild extracts imported CSS into a sibling index.css but
# does not link it from the bundle, so nothing else would apply the styles.
cat > apps/web/dist/index.html <<'EOF'
<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>WhatsApp Group Control</title><link rel="stylesheet" href="/assets/index.css" /></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>
EOF

./node_modules/.bin/tsc -p apps/api/tsconfig.json

echo 'Dashboard and API are starting at http://127.0.0.1:3001'
exec node apps/api/dist/server.js
