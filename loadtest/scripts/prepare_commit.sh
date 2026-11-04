#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ $# == 1 && "$1" =~ ^[0-9a-f]{7,40}$ ]] || { echo 'Usage: prepare_commit.sh <sha>' >&2; exit 2; }
SHA=$(git rev-parse --verify "$1^{commit}")
SHORT=$(git rev-parse --short=7 "$SHA")
DEST="$ROOT/loadtest/.baselines/$SHORT"
export npm_config_cache="$ROOT/loadtest/.npm-cache"
export UV_CACHE_DIR="$ROOT/loadtest/.uv-cache"
export UV_PYTHON_INSTALL_DIR="$ROOT/loadtest/.uv-python"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/loadtest/.pw-browsers"
mkdir -p "$ROOT/loadtest/.baselines" "$ROOT/loadtest/.logs"
if [[ ! -e "$DEST" ]]; then
  mkdir "$DEST"
  # A failed archive remains visibly incomplete; never fall back to the working tree.
  git archive "$SHA" | tar -x -C "$DEST"
  printf '%s\n' "$SHA" > "$DEST/.archive-sha"
fi
[[ $(cat "$DEST/.archive-sha") == "$SHA" ]] || { echo 'Archive mismatch/incomplete archive' >&2; exit 1; }
if [[ ! -x loadtest/.venv/bin/python ]]; then uv venv --python 3.11 loadtest/.venv; fi
loadtest/.venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3,11), sys.version'
# One shared environment, always the pinned comparison main's requirements, never a patch.
uv pip install --python loadtest/.venv/bin/python -r "$ROOT/backend/requirements.txt"
uv pip freeze --python loadtest/.venv/bin/python > loadtest/.logs/python-freeze.txt
(
  cd "$DEST/frontend"
  npm ci
  # All nine inspected commits: api/apiClient.ts uses VITE_API_BASE_URL,
  # hooks/useWebSocket.ts uses VITE_WS_BASE_URL; no historical rename is needed.
  VITE_API_BASE_URL=http://127.0.0.1:18000 VITE_WS_BASE_URL=ws://127.0.0.1:18000/ws npx --no-install vite build
)
echo "Prepared $SHA at $DEST"
