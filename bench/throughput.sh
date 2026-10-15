#!/usr/bin/env bash
# usage: bench/throughput.sh <sn|sb|sn4> <port> <server-cpuset> <connections> <path> [wrk-lua-script]
#   reads, 1 core:   bench/throughput.sh sb 5002 1 100 /notes/1
#   writes, 1 core:  bench/throughput.sh sb 5002 1 50 /notes bench/post.lua
#   reads, 4 cores:  WRK_CPUS=6-7 bench/throughput.sh sn4 5004 0-3 100 /notes/1
# Needs Postgres and Redis running locally (see bench/BENCHMARKS.md) and SCRIBE_APP_DB_PASS set.
set -u
name=$1; port=$2; cpus=$3; conns=$4; path=$5; lua=${6:-}
WRK_CPUS=${WRK_CPUS:-4-7}
# Published numbers use the defaults: WARMUP_SECS=10 RUN_SECS=20 RUNS=3 (override only for a quick dry run).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BENCH_DIR=$DIR
( taskset -c "$cpus" bash -c "source '$DIR/env.sh'; start_$name" > /dev/null 2>&1 & )
for _ in $(seq 1 300); do curl -s -o /dev/null -f "localhost:$port/notes/1" && break; sleep 0.1; done
sleep 1
lp=$(ss -ltnp "sport = :$port" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$lp" ] || { echo "server did not start on :$port" >&2; exit 1; }
tree_rss() { echo $(( $(ps -o rss= -p "$lp") + $(ps --ppid "$lp" -o rss= | awk '{s+=$1} END {print s+0}') )); }
echo "idle_rss_kb $(tree_rss) procs $(( 1 + $(ps --ppid "$lp" --no-headers | wc -l) ))"
args=(); [ -n "$lua" ] && args=(-s "$lua")
taskset -c "$WRK_CPUS" wrk -t4 -c"$conns" -d"${WARMUP_SECS:-10}"s "${args[@]}" "http://127.0.0.1:$port$path" > /dev/null   # warmup
for _ in $(seq 1 "${RUNS:-3}"); do
  taskset -c "$WRK_CPUS" wrk -t4 -c"$conns" -d"${RUN_SECS:-20}"s --latency "${args[@]}" "http://127.0.0.1:$port$path" \
    | grep -E "Requests/sec|99%|50%|Non-2xx|Socket errors" | tr -s ' ' | tr '\n' ' '; echo
done
echo "post_load_rss_kb $(tree_rss)"
kill "$lp"; sleep 1; pkill -P "$lp" 2>/dev/null; sleep 2
