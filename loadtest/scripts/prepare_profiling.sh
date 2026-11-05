#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
[[ $# -le 1 ]] || { echo 'Usage: prepare_profiling.sh [sha]' >&2; exit 2; }
TARGET=${1:-b86324b}
"$ROOT/loadtest/scripts/prepare_commit.sh" "$TARGET"
LOADTEST_COMMIT=$(git -C "$ROOT" rev-parse --short=7 "$TARGET^{commit}")
export LOADTEST_COMMIT
export npm_config_cache="$ROOT/loadtest/.npm-cache"
cd "$ROOT/loadtest/.baselines/$LOADTEST_COMMIT/frontend"
VITE_API_BASE_URL=http://127.0.0.1:18000 VITE_WS_BASE_URL=ws://127.0.0.1:18000/ws npx --no-install vite build --config "$ROOT/loadtest/vite.profiling.config.mjs"
