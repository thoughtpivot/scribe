#!/usr/bin/env bash
# usage: bench/startup.sh <sn|sb|snall> <port> [path]
# Starts the server, exits once GET <path> (default /notes/1) returns 200, then stops it. Time with hyperfine:
#   hyperfine --warmup 2 --runs 15 'bench/startup.sh sb 5002' 'bench/startup.sh sn 5001'
name=$1; port=$2; path=${3:-/notes/1}
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash -c "source '$DIR/env.sh'; start_$name" > /dev/null 2>&1 &
pid=$!
until curl -s -o /dev/null -f "http://127.0.0.1:$port$path"; do sleep 0.005; done
lp=$(ss -ltnp "sport = :$port" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)   # the actual listener
kill $pid $lp 2>/dev/null; pkill -P $pid 2>/dev/null
while ss -ltn "sport = :$port" | grep -q LISTEN; do sleep 0.01; done
