#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
"$ROOT/loadtest/scripts/prepare_commit.sh" b86324b
export npm_config_cache="$ROOT/loadtest/.npm-cache"
cd "$ROOT/loadtest/.baselines/b86324b/frontend"
VITE_API_BASE_URL=http://127.0.0.1:18000 VITE_WS_BASE_URL=ws://127.0.0.1:18000/ws npx --no-install vite build --config "$ROOT/loadtest/vite.profiling.config.mjs"
