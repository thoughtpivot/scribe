-- wrk script: POST a valid `notes` record. Run from any directory; the path is
-- resolved from the BENCH_DIR environment variable (throughput.sh exports it).
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
local f = assert(io.open(os.getenv("BENCH_DIR") .. "/post.json"))
wrk.body = f:read("*a")
f:close()
