# Scribe: Node vs Bun benchmarks

This page records how `scribe` (Node, Express on `node:cluster`) and `scribe-bun` (`Bun.serve`) were compared on one commit, and the raw numbers. Scripts and raw output are in [`bench/`](bench/). Run on 2026-10-14.

Read the [caveats](#caveats) before quoting any number. The short version: these are single-table micro-benchmarks, and Scribe writes are limited by per-insert DDL, not by the runtime.

## What was compared

| | Version | Commit |
| --- | --- | --- |
| Scribe `@thoughtpivot/scribe` | 1.3.0 | `9a0239f` |

- **Node side (before):** `scribe` is Express on `node:cluster`, built to `dist/scribe.cli.js` by `tsc`.
- **Bun side (after):** `scribe-bun` is a `Bun.serve` transport over the same `src/core.ts`, running `src/bun/server.ts` directly as TypeScript.

## Environment

- 8 vCPU Intel Xeon VM, 15 GB RAM, Debian 13, kernel 6.12. It was a shared VM with other processes running, so expect some noise.
- Node 20.19.2, Bun 1.4.2, PostgreSQL 17.11, Redis 8.0.2, wrk 4.1.0 (load), hyperfine 1.19.0 (timing).
- Postgres and Redis ran on the same VM as the server, so there is no network between them.

## Method

- **Single-core runs:** the server is pinned to core 1 with `taskset`. Postgres and Redis run on cores 2-3. wrk runs on cores 4-7 with `-t4`, using `-c100` for reads and `-c50` for writes.
- **One Node worker:** Scribe has no worker-count option, so the harness preloads [`cpus1.cjs`](bench/cpus1.cjs), which makes `os.cpus()` return one CPU. The cluster primary process still runs, as it does in production.
- **4-core runs:** the server is pinned to cores 0-3. Node runs 4 workers (through [`cpus4.cjs`](bench/cpus4.cjs)). `scribe-bun` stays its shipped single process. Postgres and Redis run on cores 4-5, and wrk on cores 6-7.
- **Each throughput row:** a 10 s warmup, then three 20 s runs. The mean is reported. No non-2xx responses or socket errors were seen in any run.
- **Memory:** RSS of the whole server process tree (Node: primary plus workers), taken at idle after one request and again after load.
- **Startup:** time from exec to the first HTTP 200 on `GET /notes/1`, measured with hyperfine (2 warmups, 15 runs).

### Workload

The component schema is [`notes.schema.json`](bench/scribe-home/components/notes/notes.schema.json), discovered at startup (the validator is cached).

- **Reads:** `GET /notes/1`.
- **Writes:** `POST /notes` with a valid record ([`post.json`](bench/post.json)). This runs the shipped create path: `CREATE TABLE IF NOT EXISTS` twice, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, the `INSERT`, and a history `INSERT`. Writes were run twice, the second time with the tables truncated first and the order of the Node and Bun runs reversed. The results matched.

## Results: single core (per-core efficiency)

| Test | Node | Bun | Change |
| --- | --- | --- | --- |
| Reads, requests/s | 4,998 | **21,349** | **4.3x** |
| Read p50 / p99 | 17-21 ms / 52-65 ms | 3.9-4.2 ms / 12.2-12.5 ms | |
| Writes, requests/s (6 runs) | 1,273 | **2,327** | **1.8x** |
| Write p50 / p99 | 33-38 ms / 70-93 ms | 18-20 ms / 43-55 ms | |
| Idle RSS | 258 MB (primary + 1 worker) | **68 MB** | about 3.8x less |
| RSS after load | 234-263 MB | 100-108 MB | |

## Results: startup to first 200 (hyperfine, 15 runs)

| | Node | Bun | Change |
| --- | --- | --- | --- |
| Scribe | 1.210 s ± 0.141 (1 worker) / 1.385 s (default, one worker per CPU = 8 here) | **319 ms ± 34** | **3.8x** |

## Results: 4 cores

| Test | Node cluster, 4 workers | Bun, one process | Note |
| --- | --- | --- | --- |
| Reads, requests/s | 21,455 | **22,768** | A tie. Postgres (2 cores) is likely the limit. Bun p99 was 8.5-10 ms against 16-20 ms. |
| RSS (idle, then after load) | 641 MB, then 700 MB | 69 MB, then 105 MB | about 1/7 the memory |

Single-core numbers measure per-core efficiency. At 4 cores the single `scribe-bun` process only ties a 4-worker Node cluster on reads, and writes were not run at 4 cores. Multi-core support for `scribe-bun` is tracked in [THO-258](https://linear.app/thoughtpivot/issue/THO-258/make-scribe-bun-multi-core-capable-workers-shared-cache-pool-sizing).

## Toolchain timings

| | Node toolchain | Bun | Change |
| --- | --- | --- | --- |
| Install, cold cache | `npm ci` 6.42 s | `bun install` 0.86 s | 7.4x |
| Install, warm cache | `npm ci` 3.81 s | `bun install` 0.72 s | 5.3x |
| TypeScript build step | `tsc` 4.41 s | none (Bun runs the TS) | step removed |
| Test cycle | `npm test` 10.59 s (tsc build, then `node --test`, 40 tests) | `bun test` 0.87 s (51 tests: the same 3 shared files plus Bun-only checks) | about 12x |

- CI and the docs still use `npm ci`, even in the Bun CI job. `bun install` is optional today.
- The Bun test timing comes from `hyperfine` runs where 4 of 8 runs exited non-zero. That is the flaky test described below, so treat the 0.87 s as indicative.
- In one GitHub Actions run (#76), the Node jobs spent 4-5 s on Build and 8-12 s on Test, and the Bun job spent 1 s on Test with no build step. That is 1-second resolution, n=1.

## Caveats

- **Micro-benchmark.** One table (`notes`), one small JSON record, reads by primary key. There are no relationships, no SQL-query endpoints, no large payloads and no mixed read/write traffic.
- **Writes are DDL-bound.** The shipped create path still runs `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on every insert, on both runtimes. That per-insert work is why writes improve only 1.8x while reads improve 4.3x. Moving it out of the request path, and caching the compiled validator, is tracked in [THO-259](https://linear.app/thoughtpivot/issue/THO-259/move-per-insert-schematable-ddl-out-of-the-request-path-cache-compiled).
- **Single process vs cluster.** At 4 cores, `scribe-bun` as one process only ties a 4-worker Node cluster on reads (22.8k against 21.5k req/s), and Postgres limits both.
- **Shared VM, local database.** The runs were on a shared 8 vCPU VM with Postgres and Redis on the same machine, so there is some noise and no network latency.
- **Validator caching.** Only discovered schema files are cached in-process. The Redis-cache and default-schema path still builds a new Ajv instance on each request.
- **Flaky Bun test.** `src/bun/dependencies.test.ts`, "express-bunyan-logger records a request", is flaky under Bun. It failed in 2 of about 11 runs while benchmarking, and again in 1 of 6 when the scripts were re-checked.
- **Versions.** Bun 1.4.2 was used locally. CI pins 1.4.3.
- **Not measured:** an end-to-end run with Flight in front and a real SPA, several `scribe-bun` processes against a Node cluster on the same cores, writes at 4 cores, container image size and Kubernetes cold start, a Postgres tuned for throughput, and long soak memory growth.
- If you get different numbers on your own hardware, please open an issue with your results.

## Reproduce

The scripts have no machine-specific paths and no stored credentials. They need Linux with `taskset` and `ss`, [wrk](https://github.com/wg/wrk), [hyperfine](https://github.com/sharkdp/hyperfine), Bun, and a local PostgreSQL and Redis. They start servers on ports 5001-5004.

```bash
npm ci && npm run build                 # builds dist/ for the Node variants
export SCRIBE_APP_DB_PASS=...           # password of your local benchmark Postgres user (required)
# optional: SCRIBE_APP_DB_HOST / _USER / _NAME, SCRIBE_APP_REDIS_HOST, BUN=/path/to/bun

# single core: reads, then writes (sn = Node, one worker; sb = scribe-bun)
bench/throughput.sh sn 5001 1 100 /notes/1
bench/throughput.sh sb 5002 1 100 /notes/1
bench/throughput.sh sn 5001 1 50 /notes bench/post.lua
bench/throughput.sh sb 5002 1 50 /notes bench/post.lua

# 4 cores, reads (sn4 = Node, four workers)
WRK_CPUS=6-7 bench/throughput.sh sn4 5004 0-3 100 /notes/1
WRK_CPUS=6-7 bench/throughput.sh sb 5002 0-3 100 /notes/1

# startup to first 200
hyperfine --warmup 2 --runs 15 'bench/startup.sh sb 5002' 'bench/startup.sh sn 5001'
```

For a quick check that the scripts run, shorten the load with `WARMUP_SECS=2 RUN_SECS=3 RUNS=1`. The published numbers use the defaults (10 s warmup, three 20 s runs).

| Raw output | File in [`bench/results/`](bench/results/) |
| --- | --- |
| 1 core, reads | `single-core-reads-node.txt`, `single-core-reads-bun.txt` |
| 1 core, writes (two passes) | `single-core-writes-node-run1.txt`, `single-core-writes-bun-run1.txt`, `single-core-writes-node-run2.txt`, `single-core-writes-bun-run2.txt` |
| 4 cores, reads | `four-core-reads-node-cluster-4-workers.txt`, `four-core-reads-bun.txt` |
| Startup, build, install, tests (hyperfine JSON) | `startup-hyperfine.json`, `build-hyperfine.json`, `inst-scribe-cold.json`, `inst-scribe-warm.json`, `tests-scribe.json`, `tests-scribe-bun.json` |

In the throughput files each line is one 20 s run (`Requests/sec`, p50 and p99 latency), plus `idle_rss_kb` and `post_load_rss_kb` for the process tree.

## Follow-ups

- [THO-258](https://linear.app/thoughtpivot/issue/THO-258/make-scribe-bun-multi-core-capable-workers-shared-cache-pool-sizing): make `scribe-bun` multi-core capable (workers, shared cache, Postgres pool sizing).
- [THO-259](https://linear.app/thoughtpivot/issue/THO-259/move-per-insert-schematable-ddl-out-of-the-request-path-cache-compiled): move the per-insert schema and table DDL out of the request path and cache the compiled validator, which is what limits writes today.
- The sibling benchmark for Flight is in [thoughtpivot/flight](https://github.com/thoughtpivot/flight/blob/main/BENCHMARKS.md).

## Prior research

Early Bun research and benchmarks for Flight and Scribe by Vasilen Lyubomirov (github.com/VasilenL), whose work helped start this. The code is in [flight-scribe-setup](https://github.com/VasilenL/flight-scribe-setup), [flight-bun](https://github.com/VasilenL/flight-bun) and [scribe-bun](https://github.com/VasilenL/scribe-bun). It was run on separate prototypes and hardware, so its numbers are not comparable with the ones on this page, and none of them are used here.
