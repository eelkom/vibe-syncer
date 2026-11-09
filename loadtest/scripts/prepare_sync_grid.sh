#!/usr/bin/env bash
# Builds measurement-only frontends of one commit with patched sync constants.
# The app source is never changed: each build patches an archived copy.
# Usage: [VARIANT=name REUSE_FROM=<sha>] prepare_sync_grid.sh <sha> <threshold_s>:<interval_ms> [...]
# VARIANT names a build of another commit (e.g. a prototype branch); its output
# lands next to the base builds as <variant>-t<T>-i<I>. REUSE_FROM links the
# node_modules of an already prepared commit when package-lock.json is identical.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ $# -ge 2 && "$1" =~ ^[0-9a-f]{7,40}$ ]] || { echo 'Usage: prepare_sync_grid.sh <sha> <threshold_s>:<interval_ms> ...' >&2; exit 2; }
SHA=$(git rev-parse --verify "$1^{commit}"); shift
SHORT=$(git rev-parse --short=7 "$SHA")
BASE="$ROOT/loadtest/.baselines/sync-grid-$SHORT"
export npm_config_cache="$ROOT/loadtest/.npm-cache"
if [[ ! -e "$BASE" ]]; then
  mkdir -p "$BASE"
  git archive "$SHA" frontend | tar -x -C "$BASE"
  printf '%s\n' "$SHA" > "$BASE/.archive-sha"
  if [[ -n "${REUSE_FROM:-}" ]]; then
    SRC="$ROOT/loadtest/.baselines/sync-grid-$REUSE_FROM/frontend"
    cmp -s "$SRC/package-lock.json" "$BASE/frontend/package-lock.json" || { echo 'package-lock differs; cannot reuse' >&2; exit 1; }
    ln -s "$SRC/node_modules" "$BASE/frontend/node_modules"
  else
    (cd "$BASE/frontend" && npm ci --silent)
  fi
fi
[[ $(cat "$BASE/.archive-sha") == "$SHA" ]] || { echo 'Archive mismatch' >&2; exit 1; }
HOOK="$BASE/frontend/src/page/MusicRoom/hooks/useMusicPlayer.ts"
ORIG="$HOOK.orig"
[[ -e "$ORIG" ]] || cp "$HOOK" "$ORIG"
for combo in "$@"; do
  [[ "$combo" =~ ^([0-9.]+):([0-9]+)$ ]] || { echo "Bad combo $combo" >&2; exit 2; }
  T=${BASH_REMATCH[1]}; I=${BASH_REMATCH[2]}
  if [[ -n "${VARIANT:-}" ]]; then OUT="$ROOT/loadtest/.baselines/sync-grid-${GRID:?GRID=<base sha> required with VARIANT}-dist/${VARIANT}-t${T}-i${I}"
  else OUT="$ROOT/loadtest/.baselines/sync-grid-$SHORT-dist/t${T}-i${I}"; fi
  [[ -f "$OUT/index.html" ]] && { echo "Exists $OUT"; continue; }
  cp "$ORIG" "$HOOK"
  # Exactly one occurrence of each constant must be replaced.
  [[ $(grep -c 'Math.abs(currentPlayerTime - timestamp) >= 2$' "$HOOK") == 1 ]] || { echo 'threshold pattern not unique' >&2; exit 1; }
  [[ $(grep -c '^const HOST_SYNC_INTERVAL_MS = 5000;$' "$HOOK") == 1 ]] || { echo 'interval pattern not unique' >&2; exit 1; }
  sed -i '' -e "s/Math.abs(currentPlayerTime - timestamp) >= 2\$/Math.abs(currentPlayerTime - timestamp) >= ${T}/" \
    -e "s/^const HOST_SYNC_INTERVAL_MS = 5000;\$/const HOST_SYNC_INTERVAL_MS = ${I};/" "$HOOK"
  (cd "$BASE/frontend" && VITE_API_BASE_URL=https://vibe-syncer.onrender.com VITE_WS_BASE_URL=wss://vibe-syncer.onrender.com/ws \
    npx --no-install vite build --outDir "$OUT" --emptyOutDir --logLevel error)
  grep -rq "wss://vibe-syncer.onrender.com/ws" "$OUT/assets" || { echo 'WS URL missing in build' >&2; exit 1; }
  printf '{"sha":"%s","variant":"%s","threshold_s":%s,"interval_ms":%s}\n' "$SHA" "${VARIANT:-}" "$T" "$I" > "$OUT/sync-grid.json"
  echo "Built $OUT"
done
cp "$ORIG" "$HOOK"
