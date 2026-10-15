# Scribe: Node vs Bun benchmark

Early Bun research and benchmarks for Flight and Scribe by Vasilen Lyubomirov (github.com/VasilenL), whose work helped start this.

This folder holds the scripts, test app and raw outputs behind the Node vs Bun numbers for Scribe. They were run on 2026-10-14 (evening ET) against commit `9a0239f` (1.3.0). Raw outputs are in `results/`.

## Read this first

- Single-core results measure per-core efficiency. They are not a statement about a whole machine.
- **Scribe writes are DDL-bound.** The shipped create path runs `CREATE TABLE IF NOT EXISTS` twice and `ALTER TABLE ADD COLUMN IF NOT EXISTS` on every insert, on both runtimes. That is why writes improve 1.8x while reads improve 4.3x.
- **On 4 cores reads are a tie** (Node cluster 21,455 vs Bun 22,768 req/s). Postgres on 2 cores is likely the limit. The same Bun port loses to a Node cluster on raw hello-route throughput in Flight (80.7k vs 53.8k req/s on 4 cores), so do not read the single-core ratios as a general Bun advantage.
- Reads are `GET /notes/1`, a simple primary-key lookup. They are micro-benchmarks and say little about a real workload.
- Node and Bun ran different default middleware. Node's 1.2 s startup includes loading the cluster primary and workers (1.39 s with the default 8 workers).
- Not measured: end-to-end Flight to Scribe to Postgres with a real SPA, multi-process Bun against a Node cluster, container size and pod cold start, and long soak memory growth.

## What was compared

| | Runtime path |
|---|---|
| Node (before) | `scribe` = Express on `node:cluster`, `dist/scribe.cli.js` |
| Bun (after) | `scribe-bun` = `Bun.serve` transport over the same `src/core.ts` |

The component schema comes from `scribe-home/components/notes/notes.schema.json` (discovered at startup, validator cached).

## Environment

- 8 vCPU Intel Xeon VM, 15 GB RAM, Debian 13, kernel 6.12. It was a shared box with other processes running, so expect some noise.
- Node 20.19.2 (the repo `.nvmrc` says 20.11). Bun 1.4.2 (CI pins 1.4.3). PostgreSQL 17.11. Redis 8.0.2.
- wrk 4.1.0 for load, hyperfine 1.19.0 for timing.

## Method

- Single-core runs: the server is pinned to core 1. Postgres and Redis ran on cores 2-3. wrk ran on cores 4-7 (`-t4 -c100`, `-c50` for writes).
- The Node cluster is held to one worker for single-core runs. Scribe has no worker knob, so `cpus1.cjs` is preloaded and makes `os.cpus()` return one CPU. The primary process still runs, as it does in production.
- 4-core runs: the server is pinned to cores 0-3. Node runs 4 workers (through `cpus4.cjs`). Bun runs its single shipped process. Postgres and Redis on cores 4-5, wrk on cores 6-7.
- Each throughput row is a 10 s warmup, then 3 runs of 20 s. The mean is reported. No non-2xx responses or socket errors were seen.
- Writes are `POST /notes` with a valid record (`post.json`, `post.lua`). They were run twice, the second time with the tables truncated first and the order reversed. Results matched.
- Memory is RSS of the whole server process tree (Node: primary plus workers), taken at idle after one request and again after load.
- Startup is the time from exec to the first 200 on `GET /notes/1`, measured with hyperfine (2 warmups, 15 runs).

## Results: single core

| Test | Node | Bun | Change |
|---|---|---|---|
| Reads req/s | 4,998 | 21,349 | 4.3x |
| Read p50 / p99 | 17-21 ms / 52-65 ms | 3.9-4.2 ms / 12.2-12.5 ms | |
| Writes req/s (6 runs) | 1,273 | 2,327 | 1.8x |
| Write p50 / p99 | 33-38 ms / 70-93 ms | 18-20 ms / 43-55 ms | |
| Idle RSS | 258 MB (primary + 1 worker) | 68 MB | about 3.8x less |
| RSS after load | 234-263 MB | 100-108 MB | |

## Results: startup to first 200

| | Node | Bun | Change |
|---|---|---|---|
| `GET /notes/1` | 1.210 s ± 0.141 (1 worker) / 1.385 s (default 8 workers) | 319 ms ± 34 | 3.8x |

## Results: 4 cores

| Test | Node cluster, 4 workers | Bun, one process | Note |
|---|---|---|---|
| Reads req/s | 21,455 | 22,768 | A tie. Postgres on 2 cores is likely the limit. Bun p99 was 8.5-10 ms vs 16-20 ms. |
| RSS (idle to after load) | 641 to 700 MB | 69 to 105 MB | About 1/7 the memory. |

## Toolchain timings

| | Node toolchain | Bun | Change |
|---|---|---|---|
| Install, cold cache | `npm ci` 6.42 s | `bun install` 0.86 s | 7.4x |
| Install, warm cache | 3.81 s | 0.72 s | 5.3x |
| TypeScript build step | `tsc` 4.41 s | none (Bun runs the TS) | step removed |
| Test cycle | `npm test` 10.59 s (tsc build + node --test, 40 tests) | `bun test` 0.87 s (51 tests: the same 3 shared files plus Bun-only checks) | about 12x |

CI and the docs still run `npm ci`, even in the Bun CI job, so `bun install` is optional today.

## Findings from the run

- `src/bun/dependencies.test.ts`, "express-bunyan-logger records a request", is flaky under Bun. It failed in 2 of about 11 local runs.
- The Redis-cache and default-schema path builds a new Ajv instance and compiles on each request. Only discovered schema files are cached in-process.
- Moving DDL off the hot path (the migrations work) is the obvious next optimization for writes.

## Reproduce

Requirements: Linux, `wrk`, `hyperfine`, Bun, Node, `taskset`, a local Postgres and a local Redis.

1. Create a throwaway Postgres database (default name `bench`) and user, and start Redis on `127.0.0.1`. Defaults for host, user, database and Redis host are in `env.sh` and can be overridden.
2. `npm ci && npm run build`
3. `export SCRIBE_APP_DB_PASS=<password of your local benchmark Postgres user>` (it is required and never stored in the repo)
4. Run the scripts:

```bash
# reads, 1 core
bench/throughput.sh sb 5002 1 100 /notes/1
# writes, 1 core
bench/throughput.sh sb 5002 1 50 /notes bench/post.lua
# reads, 4 cores
WRK_CPUS=6-7 bench/throughput.sh sn4 5004 0-3 100 /notes/1
# startup
hyperfine --warmup 2 --runs 15 'bench/startup.sh sb 5002' 'bench/startup.sh sn 5001'
```
