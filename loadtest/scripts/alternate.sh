#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 5 || ! $5 =~ ^[1-9][0-9]*$ ]]; then
  echo 'Usage: alternate.sh <scenario> <condition> <shaA> <shaB> <runs>' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
for ((n=1; n<=$5; n++)); do
  node loadtest/run_stage1.mjs --scenario "$1" --condition "$2" --commit "$3" --runs "$n"
  node loadtest/run_stage1.mjs --scenario "$1" --condition "$2" --commit "$4" --runs "$n"
done
