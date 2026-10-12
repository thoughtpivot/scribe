# Scribe dependencies under Bun

Checked with Bun 1.4.3 against PostgreSQL 16 and Redis 7. `scribe-bun` connects to both for create, read, update, and delete (`src/bun/server.test.ts`). Each library below was exercised from `src/bun/dependencies.test.ts`. Nothing failed, so no dependency was replaced.

The Bun transport logs with `console.log` and `console.error`. `express-bunyan-logger` stays on the Express production path and also loads under Bun.

| Dependency | Result | What was checked |
| --- | --- | --- |
| `pg-promise` / `pg` | Pass | Create, insert, update, select, and delete on Postgres |
| `pgtools` | Pass | `CREATE DATABASE`, duplicate database, and a password function (IAM-shaped config). `tryCreateDb` is idempotent |
| `redis` | Pass | `SET` / `GET` / `DEL`, and `/healthz` via the schema cache |
| `@aws-sdk/rds-signer` | Pass | Offline `getAuthToken` with static credentials. The token is a signed URL |
| `express-bunyan-logger` | Pass | Request log on a stream and a rotating file. Bun's own server uses console logging |
| `ajv` | Pass | `compile` and `compileAsync` |
| `luxon` | Pass | UTC timestamps used on record writes |
| `diff-match-patch` | Pass | `patch_make`, `patch_toText`, and `patch_apply` |
| `yargs` | Pass | Flag parsing and the `SCRIBE_APP` env prefix used by `src/core.ts` |
