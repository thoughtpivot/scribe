#!/usr/bin/env bash
# Source this file: `source bench/env.sh`. Defines the Scribe server variants.
#   SCRIBE_REPO         repo root (default: parent of this folder). Run `npm run build` first for the Node variants.
#   BUN                 Bun executable (default: `bun` on PATH). If your `bun` is a launcher script
#                       that spawns a child, point BUN at the real binary so RSS and kill hit the right process.
#   SCRIBE_APP_DB_PASS  REQUIRED: password of the local benchmark Postgres user. Not stored in the repo.
#   SCRIBE_APP_DB_HOST / _USER / _NAME, SCRIBE_APP_REDIS_HOST  default to a local, throwaway setup.
BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BENCH_DIR
export SCRIBE_REPO="${SCRIBE_REPO:-$(cd "$BENCH_DIR/.." && pwd)}"
export BUN="${BUN:-$(command -v bun)}"
: "${SCRIBE_APP_DB_PASS:?set SCRIBE_APP_DB_PASS to the password of your local benchmark Postgres user}"
export SCRIBE_APP_DB_HOST="${SCRIBE_APP_DB_HOST:-127.0.0.1}"
export SCRIBE_APP_DB_USER="${SCRIBE_APP_DB_USER:-postgres}"
export SCRIBE_APP_DB_NAME="${SCRIBE_APP_DB_NAME:-bench}"
export SCRIBE_APP_REDIS_HOST="${SCRIBE_APP_REDIS_HOST:-127.0.0.1}"
export SCRIBE_APP_MODE=bench
S="$SCRIBE_REPO"
H="$BENCH_DIR/scribe-home"   # app home: holds components/notes/notes.schema.json

# sn:    Node, node:cluster held to ONE worker (cpus1.cjs makes os.cpus() return one CPU)
start_sn()    { cd "$H" && SCRIBE_APP_PORT=5001 exec node --require "$BENCH_DIR/cpus1.cjs" "$S/dist/scribe.cli.js"; }
# snall: Node, default workers (one per CPU)
start_snall() { cd "$H" && SCRIBE_APP_PORT=5003 exec node "$S/dist/scribe.cli.js"; }
# sb:    scribe-bun, single process
start_sb()    { cd "$H" && SCRIBE_APP_PORT=5002 exec "$BUN" "$S/src/bun/server.ts"; }
# sn4:   Node, FOUR workers (cpus4.cjs)
start_sn4()   { cd "$H" && SCRIBE_APP_PORT=5004 exec node --require "$BENCH_DIR/cpus4.cjs" "$S/dist/scribe.cli.js"; }
