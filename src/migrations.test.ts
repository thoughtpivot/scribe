/**
 * Migrations table and runner, shared by Node (`node --test`) and Bun (`bun test`).
 */
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
    appliedMigrationFilenames,
    applyMigrations,
    discoverMigrationFiles,
    MIGRATIONS_TABLE,
    runMigrations,
    type MigrationDb
} from "./migrations.js"

process.env.SCRIBE_APP_DB_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_DB_PORT ??= "5432"
process.env.SCRIBE_APP_DB_USER ??= "postgres"
process.env.SCRIBE_APP_DB_PASS ??= "postgres"
process.env.SCRIBE_APP_DB_NAME ??= "scribe_routes_test"
process.env.SCRIBE_APP_REDIS_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_REDIS_PORT ??= "6379"
process.env.SCRIBE_APP_PORT ??= "0"

const admin = {
    host: process.env.SCRIBE_APP_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.SCRIBE_APP_DB_PORT ?? 5432),
    user: process.env.SCRIBE_APP_DB_USER ?? "postgres",
    password: process.env.SCRIBE_APP_DB_PASS ?? "postgres"
}

describe("migration discovery", () => {
    it("sorts by filename and skips node_modules", () => {
        withTree((root) => {
            writeText(root, "nested/20240102000000.b.migration.ts", "")
            writeText(root, "20240103000000.c.migration.js", "")
            writeText(root, "20240101000000.a.migration.mjs", "")
            writeText(root, "node_modules/pkg/000.skip.migration.js", "")
            writeText(root, "notes.migration.ts.bak", "")

            assert.deepEqual(
                discoverMigrationFiles(root).map((file) => path.basename(file)),
                ["20240101000000.a.migration.mjs", "20240102000000.b.migration.ts", "20240103000000.c.migration.js"]
            )
        })
    })

    it("rejects duplicate filenames", () => {
        withTree((root) => {
            writeText(root, "one/20240101000000.same.migration.js", "")
            writeText(root, "two/20240101000000.same.migration.js", "")
            assert.throws(() => discoverMigrationFiles(root), /Duplicate migration filename 20240101000000.same.migration.js/)
        })
    })

    it("returns no files when the directory is missing", () => {
        assert.deepEqual(discoverMigrationFiles(path.join(tmpdir(), "scribe-migrations-missing")), [])
    })

    it("does not import Express", () => {
        const source = readMigrationsSource()

        assert.doesNotMatch(source, /from ["']express["']/)
        assert.doesNotMatch(source, /require\(["']express["']\)/)
    })

    it("is the runner both servers share through core", async () => {
        const core = await import("./core.js")

        assert.equal(core.runMigrations, runMigrations)
        assert.equal(typeof core.ScribeCore.prototype.runMigrations, "function")
    })
})

describe("migrations table and runner", { concurrency: false }, () => {
    const dbName = `scribe_mig_${process.pid}`
    let db: MigrationDb & { $pool: { end: () => Promise<void> } }

    before(async () => {
        const pgtools = (await import("pgtools")).default

        try {
            await pgtools.dropdb(admin, dbName)
        } catch (err) {
            if ((err as { name?: string }).name !== "invalid_catalog_name") throw err
        }

        await pgtools.createdb(admin, dbName)
        const pgp = (await import("pg-promise")).default

        db = pgp()({ ...admin, database: dbName })
    })

    after(async () => {
        await db.$pool.end()
        const pgtools = (await import("pgtools")).default

        await pgtools.dropdb(admin, dbName)
    })

    it("stores filenames as the primary key and has no version column", async () => {
        await db.none(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`)
        const names = await appliedMigrationFilenames(db)

        assert.deepEqual(names, [])
        const columns = await db.any<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
            [MIGRATIONS_TABLE]
        )

        assert.deepEqual(
            columns.map((column) => column.column_name),
            ["applied_at", "filename"]
        )
        await db.none(`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`, ["20240101000000.users.migration.ts"])
        await assert.rejects(
            () => db.none(`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`, ["20240101000000.users.migration.ts"]),
            (err: unknown) => (err as { code?: string }).code === "23505"
        )
    })

    it("applies pending ups in order, records them, and skips them on re-run", async () => {
        await db.none(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`)
        await db.none("DROP TABLE IF EXISTS mig_log")
        await db.none("CREATE TABLE mig_log(seq serial PRIMARY KEY, name text)")
        let calls = 0
        const steps = [
            {
                filename: "20240102000000.beta.migration.ts",
                up: async (task: MigrationDb) => {
                    calls += 1
                    await task.none("INSERT INTO mig_log(name) VALUES($1)", ["beta"])
                }
            },
            {
                filename: "20240101000000.alpha.migration.ts",
                up: async (task: MigrationDb) => {
                    calls += 1
                    await task.none("INSERT INTO mig_log(name) VALUES($1)", ["alpha"])
                }
            }
        ]
        const first = await applyMigrations(db, steps)
        const second = await applyMigrations(db, steps)
        const log = await db.any<{ name: string }>("SELECT name FROM mig_log ORDER BY seq")

        assert.deepEqual(first, ["20240102000000.beta.migration.ts", "20240101000000.alpha.migration.ts"])
        assert.deepEqual(second, [])
        assert.equal(calls, 2)
        assert.deepEqual(
            log.map((row) => row.name),
            ["beta", "alpha"]
        )
        assert.deepEqual(await appliedMigrationFilenames(db), ["20240101000000.alpha.migration.ts", "20240102000000.beta.migration.ts"])
    })

    it("does not record a failed up and does not run later files", async () => {
        await db.none(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`)
        await db.none("DROP TABLE IF EXISTS mig_log")
        await db.none("CREATE TABLE mig_log(name text)")
        const calls: string[] = []

        await assert.rejects(
            () =>
                applyMigrations(db, [
                    {
                        filename: "1.ok.migration.ts",
                        up: async (task) => {
                            calls.push("ok")
                            await task.none("INSERT INTO mig_log(name) VALUES($1)", ["ok"])
                        }
                    },
                    {
                        filename: "2.bad.migration.ts",
                        up: async (task) => {
                            calls.push("bad")
                            await task.none("INSERT INTO mig_log(name) VALUES($1)", ["bad"])
                            throw new Error("boom")
                        }
                    },
                    {
                        filename: "3.later.migration.ts",
                        up: async () => {
                            calls.push("later")
                        }
                    }
                ]),
            /boom/
        )

        assert.deepEqual(calls, ["ok", "bad"])
        assert.deepEqual(await appliedMigrationFilenames(db), ["1.ok.migration.ts"])
        assert.deepEqual(await db.any("SELECT name FROM mig_log"), [{ name: "ok" }])
    })

    it("runs discovered files in filename order and applies zero recorded migrations on re-run", async () => {
        await db.none(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`)
        await db.none("DROP TABLE IF EXISTS mig_probe")

        await withTree(async (root) => {
            writeText(
                root,
                "nested/20240102000000.beta.migration.mjs",
                `export async function up(db) { await db.none("INSERT INTO mig_probe(name) VALUES('beta')") }\n`
            )
            writeText(
                root,
                "20240101000000.alpha.migration.mjs",
                `export async function up(db) { await db.none("CREATE TABLE mig_probe(name text)"); await db.none("INSERT INTO mig_probe(name) VALUES('alpha')") }\n`
            )
            const first = await runMigrations(db, root)
            const second = await runMigrations(db, root)
            const rows = await db.any<{ name: string }>("SELECT name FROM mig_probe")

            assert.deepEqual(first.applied, ["20240101000000.alpha.migration.mjs", "20240102000000.beta.migration.mjs"])
            assert.deepEqual(second.applied, [])
            assert.deepEqual(rows.map((row) => row.name).sort(), ["alpha", "beta"])
        })
    })
})

/**
 * @param files written relative to a temp root
 * @param run
 */
async function withTree(run: (root: string) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "scribe-migrations-"))

    try {
        await run(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

/**
 * @param root
 * @param rel
 * @param contents
 */
function writeText(root: string, rel: string, contents: string): void {
    const abs = path.join(root, rel)

    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, contents)
}

/**
 *
 */
function readMigrationsSource(): string {
    const here = path.dirname(fileURLToPath(import.meta.url))

    for (const name of ["migrations.ts", "migrations.js"]) {
        const file = path.join(here, name)

        if (existsSync(file)) return readFileSync(file, "utf8")
    }

    throw new Error("migrations source not found")
}
