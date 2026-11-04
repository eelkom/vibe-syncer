#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export LC_ALL=C
export PGDATA="$ROOT/loadtest/.pg"
PGBIN=${PGBIN:-$(pg_config --bindir)}
case "${1:-}" in
  initdb)
    if [[ -e "$PGDATA" ]]; then echo "PGDATA exists; refusing initdb" >&2; exit 1; fi
    "$PGBIN/initdb" -D "$PGDATA" -U vibe --auth=trust --encoding=UTF8 --locale=C
    cat >> "$PGDATA/postgresql.conf" <<'CONF'
port = 55432
listen_addresses = '127.0.0.1'
max_connections = 300
CONF
    ;;
  start) "$PGBIN/pg_ctl" -D "$PGDATA" -l "$ROOT/loadtest/.pg.log" -o "-p 55432 -h 127.0.0.1 -c max_connections=300" start ;;
  stop) "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop ;;
  *) echo "Usage: $0 {initdb|start|stop}" >&2; exit 2 ;;
esac
