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

# Build the dashboard and API only when their sources changed. Re-running
# esbuild and tsc on every launch caused avoidable CPU and HDD activity.
webIndex="apps/web/dist/index.html"
webBundle="apps/web/dist/assets/index.js"
webStyles="apps/web/dist/assets/index.css"
apiBundle="apps/api/dist/server.js"
buildWeb=0
buildApi=0

if [[ ! -f "$webIndex" || ! -f "$webBundle" || ! -f "$webStyles" ]] \
  || find apps/web/src -type f -newer "$webIndex" -print -quit | grep -q . \
  || [[ package-lock.json -nt "$webIndex" || apps/web/package.json -nt "$webIndex" || apps/web/vite.config.ts -nt "$webIndex" ]]; then
  buildWeb=1
fi

if [[ ! -f "$apiBundle" ]] \
  || find apps/api/src -type f -newer "$apiBundle" -print -quit | grep -q . \
  || [[ package-lock.json -nt "$apiBundle" || apps/api/package.json -nt "$apiBundle" || apps/api/tsconfig.json -nt "$apiBundle" ]]; then
  buildApi=1
fi

if (( buildWeb )); then
  echo 'Building dashboard (first launch or source changes)...'
  mkdir -p apps/web/dist/assets
  ./node_modules/.bin/esbuild apps/web/src/main.tsx \
    --bundle --format=esm --platform=browser --target=es2022 --jsx=automatic \
    "--outfile=apps/web/dist/assets/index.js" --loader:.tsx=tsx --loader:.css=css

  # The compiled server serves this dashboard entry point and extracted CSS.
  cat > "$webIndex" <<'EOF'
<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>WhatsApp Group Control</title><link rel="stylesheet" href="/assets/index.css" /></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>
EOF
fi

if (( buildApi )); then
  echo 'Building API (first launch or source changes)...'
  ./node_modules/.bin/tsc -p apps/api/tsconfig.json
fi

if (( ! buildWeb && ! buildApi )); then
  echo 'Using existing build (no source changes).'
fi

echo 'Dashboard and API are starting at http://127.0.0.1:3001'
exec node apps/api/dist/server.js
