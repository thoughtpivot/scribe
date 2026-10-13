/**
 * Migration file format and the generate/run CLI, on Node and Bun.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"

import { componentSlug, generateMigration, migrationFilename, migrationTimestamp, parseMigrationFilename } from "./migration-file.js"
import { parseMigrationArgs } from "./migrations.cli.js"
import { importMigration } from "./migrations.js"

process.env.SCRIBE_APP_DB_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_DB_PORT ??= "5432"
process.env.SCRIBE_APP_DB_USER ??= "postgres"
process.env.SCRIBE_APP_DB_PASS ??= "postgres"
process.env.SCRIBE_APP_DB_NAME ??= "scribe_routes_test"
process.env.SCRIBE_APP_REDIS_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_REDIS_PORT ??= "6379"
process.env.SCRIBE_APP_PORT ??= "0"

const stamp = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))

describe("migration file format", () => {
    it("names files {timestamp}.{component}.migration.ts", () => {
        assert.equal(migrationTimestamp(stamp), "20260102030405")
        assert.equal(componentSlug("Users"), "users")
        assert.equal(componentSlug("Users/Profile"), "users-profile")
        assert.equal(migrationFilename("Users", stamp), "20260102030405.users.migration.ts")
        assert.deepEqual(parseMigrationFilename("20260102030405.users-profile.migration.ts"), {
            timestamp: "20260102030405",
            component: "users-profile"
        })
        assert.equal(parseMigrationFilename("users.migration.ts"), undefined)
        assert.throws(() => componentSlug("..."), /Component name is required/)
    })

    it("generate writes an up/down stub and does not overwrite it", () => {
        const root = mkdtempSync(path.join(tmpdir(), "scribe-mig-stub-"))

        try {
            const written = generateMigration({ component: "Users", directory: root, now: stamp })

            assert.equal(written.filename, "20260102030405.users.migration.ts")
            assert.equal(path.basename(written.path), written.filename)
            const source = readFileSync(written.path, "utf8")

            assert.match(source, /export async function up\(db\)/)
            assert.match(source, /export async function down\(db\)/)
            assert.throws(() => generateMigration({ component: "Users", directory: root, now: stamp }), /already exists/)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it("parses generate and run", () => {
        const generated = parseMigrationArgs(["generate", "Users/Profile", "--dir", "db/migrations", "--timestamp", "20260102030405"])

        assert.equal(generated.command, "generate")
        assert.equal(generated.component, "Users/Profile")
        assert.equal(generated.dir, "db/migrations")
        assert.equal(generated.timestamp, "20260102030405")
        assert.equal(parseMigrationArgs(["run", "--dir", "migrations"]).command, "run")
        assert.throws(() => parseMigrationArgs(["generate", "Users", "--timestamp", "yesterday"]), /YYYYMMDDHHmmss/)
        assert.throws(() => parseMigrationArgs([]), /generate/)
    })

    it("does not import Express", () => {
        for (const file of ["src/migration-file.ts", "src/migrations.cli.ts", "src/scribe.cli.ts"]) {
            const source = readFileSync(file, "utf8")

            assert.doesNotMatch(source, /from ["']express["']/)
            assert.doesNotMatch(source, /require\(["']express["']\)/)
        }

        assert.doesNotMatch(readFileSync("src/scribe.cli.ts", "utf8"), /from ["']\.\/scribe\.js["']/)
        assert.match(readFileSync("src/bun/server.ts", "utf8"), /migrationCommand/)
    })
})

describe("migration CLI", { concurrency: false }, () => {
    const directories: string[] = []

    after(() => {
        for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    })

    it("generate then run applies the stub once", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "scribe-mig-cli-"))

        directories.push(root)
        const component = `probe${process.pid}x${Date.now()}`
        const generated = spawnCli(root, ["generate", component, "--dir", "migrations", "--timestamp", "20260102030405"])

        assert.equal(generated.status, 0, generated.stderr || generated.stdout)
        const filename = `20260102030405.${component}.migration.ts`
        const source = readFileSync(path.join(root, "migrations", filename), "utf8")

        assert.match(source, /export async function up/)
        assert.match(source, /export async function down/)
        assert.match(generated.stdout, /Review it/)

        const loaded = await importMigration(path.join(root, "migrations", filename))

        assert.equal(typeof loaded.up, "function")
        assert.equal(typeof loaded.down, "function")

        const first = spawnCli(root, ["run", "--dir", "migrations"])
        const second = spawnCli(root, ["run", "--dir", "migrations"])

        assert.equal(first.status, 0, first.stderr || first.stdout)
        assert.match(first.stdout, new RegExp(`Applied ${filename}`))
        assert.equal(second.status, 0, second.stderr || second.stdout)
        assert.match(second.stdout, /No pending migrations/)

        const recorded = await recordedFilenames()

        assert.ok(recorded.includes(filename))
    })
})

/**
 * @param appHome
 * @param args
 */
function spawnCli(appHome: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const bun = Boolean(process.versions.bun)
    const command = bun ? [process.execPath, "src/bun/server.ts"] : [process.execPath, "dist/scribe.cli.js"]
    const result = spawnSync(command[0], [...command.slice(1), ...args, "--app_home", appHome], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
        timeout: 20000
    })

    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`
    }
}

/**
 *
 */
async function recordedFilenames(): Promise<string[]> {
    const pgPromise = (await import("pg-promise")).default
    const db = pgPromise()({
        host: process.env.SCRIBE_APP_DB_HOST,
        port: Number(process.env.SCRIBE_APP_DB_PORT),
        user: process.env.SCRIBE_APP_DB_USER,
        password: process.env.SCRIBE_APP_DB_PASS,
        database: process.env.SCRIBE_APP_DB_NAME
    })

    try {
        const rows = await db.any<{ filename: string }>("SELECT filename FROM scribe_migrations")

        return rows.map((row) => row.filename)
    } finally {
        await db.$pool.end()
    }
}
