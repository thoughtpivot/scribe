/**
 * Migrations table, runner, schema diff, and CLI.
 * Shared by Node (`node --test`) and Bun (`bun test`).
 * No Express. Postgres is optional: live conversion uses an in-memory query.
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
    applyPendingMigrations,
    compareMigrationFilenames,
    columnsFromJsonSchema,
    diffTableAgainstSchema,
    discoverMigrationFiles,
    extractExportedStringArray,
    fileStemFromComponent,
    jsonSchemaTypeToSql,
    listAppliedFilenames,
    loadMigrationModule,
    MIGRATIONS_TABLE,
    migrateComponentToSchema,
    migrationFilename,
    normalizeSqlType,
    openMigrationConnection,
    parseMigrationFilename,
    renderMigrationFile,
    renderMigrationRouteFile,
    routeFilename,
    sqlForPlan,
    tableNameFromComponent,
    writeMigrationFile,
    type SqlQuery
} from "./migrations.js"
import { executeMigrate, MIGRATE_USAGE, parseMigrateArgs } from "./migrations-cli.js"

const defaultSchema = {
    type: "object",
    properties: {
        data: { type: "object" },
        date_created: { type: "string", format: "date-time" },
        date_modified: { type: "string", format: "date-time" },
        created_by: { type: "integer" },
        modified_by: { type: "integer" }
    }
}

describe("migration filenames", () => {
    it("parses {timestamp}.{component}.migration.ts and rejects other names", () => {
        const parsed = parseMigrationFilename("20261012235900.users.migration.ts")

        assert.deepEqual(parsed, {
            filename: "20261012235900.users.migration.ts",
            timestamp: "20261012235900",
            component: "users"
        })
        assert.equal(parseMigrationFilename("users.migration.ts"), undefined)
        assert.equal(parseMigrationFilename("1.2.3.users.migration.ts"), undefined)
        assert.equal(migrationFilename("20261012235900", "users"), "20261012235900.users.migration.ts")
        assert.equal(routeFilename("users"), "users.migration.backend.ts")
        assert.equal(fileStemFromComponent("Users/Profile"), "Users_Profile")
        assert.equal(tableNameFromComponent("Users/Profile"), "Users_Profile")
    })

    it("sorts filenames by the timestamp prefix", () => {
        const names = ["20261012235901.users.migration.ts", "20261012235900.users.migration.ts", "20261013000000.users.migration.ts"]

        names.sort(compareMigrationFilenames)
        assert.deepEqual(names, ["20261012235900.users.migration.ts", "20261012235901.users.migration.ts", "20261013000000.users.migration.ts"])
    })

    it("rejects unsafe component names", () => {
        assert.throws(() => tableNameFromComponent("users;drop"), /Invalid component/)
        assert.throws(() => tableNameFromComponent(""), /required/)
    })
})

describe("schema-driven SQL", () => {
    it("maps JSON Schema types the same way formatQueryData does", () => {
        assert.equal(jsonSchemaTypeToSql({ type: "integer" }), "integer")
        assert.equal(jsonSchemaTypeToSql({ type: "number" }), "float8")
        assert.equal(jsonSchemaTypeToSql({ type: "string" }), "text")
        assert.equal(jsonSchemaTypeToSql({ type: "string", format: "date-time" }), "timestamptz")
        assert.equal(jsonSchemaTypeToSql({ type: "object" }), "jsonb")
        assert.equal(jsonSchemaTypeToSql({ type: "array" }), "jsonb")
        assert.equal(jsonSchemaTypeToSql({ type: "boolean" }), "boolean")
        assert.equal(jsonSchemaTypeToSql({ type: "unknown" }), undefined)
        assert.equal(normalizeSqlType("double precision"), "float8")
        assert.equal(normalizeSqlType("timestamp with time zone"), "timestamptz")
        assert.equal(normalizeSqlType("int4"), "integer")
    })

    it("plans CREATE TABLE when the live table is missing", () => {
        const plan = diffTableAgainstSchema("users", [], defaultSchema)

        assert.equal(plan.changes[0]?.kind, "create_table")
        const sql = sqlForPlan(plan)
        assert.match(sql.up[0], /CREATE TABLE IF NOT EXISTS users\(/)
        assert.match(sql.up[0], /data jsonb/)
        assert.match(sql.up[1], /users_history/)
        assert.match(sql.down[0], /DROP TABLE IF EXISTS users, users_history/)
        assert.deepEqual(
            columnsFromJsonSchema(defaultSchema).map((column) => column.name),
            ["data", "date_created", "date_modified", "created_by", "modified_by"]
        )
    })

    it("plans ADD COLUMN and ALTER COLUMN against live Postgres columns", () => {
        const live = [
            { name: "id", sqlType: "int4" },
            { name: "data", sqlType: "jsonb" },
            { name: "created_by", sqlType: "text" }
        ]
        const schema = {
            properties: {
                data: { type: "object" },
                email: { type: "string" },
                created_by: { type: "integer" }
            }
        }
        const plan = diffTableAgainstSchema("users", live, schema)
        const kinds = plan.changes.map((change) => change.kind)

        assert.deepEqual(kinds, ["add_column", "alter_column"])
        const sql = sqlForPlan(plan)
        assert.equal(sql.up[0], "ALTER TABLE users ADD COLUMN IF NOT EXISTS email text")
        assert.equal(sql.up[1], "ALTER TABLE users ALTER COLUMN created_by TYPE integer")
        assert.equal(sql.down[0], "ALTER TABLE users ALTER COLUMN created_by TYPE text")
        assert.equal(sql.down[1], "ALTER TABLE users DROP COLUMN IF EXISTS email")
    })

    it("plans nothing when the live table already matches", () => {
        const live = [
            { name: "id", sqlType: "int4" },
            { name: "data", sqlType: "jsonb" },
            { name: "date_created", sqlType: "timestamptz" },
            { name: "date_modified", sqlType: "timestamptz" },
            { name: "created_by", sqlType: "integer" },
            { name: "modified_by", sqlType: "integer" }
        ]

        assert.deepEqual(diffTableAgainstSchema("users", live, defaultSchema).changes, [])
        assert.deepEqual(sqlForPlan({ table: "users", changes: [] }), { up: [], down: [] })
    })
})

describe("migration files and runner", () => {
    it("discovers pending files in fixed order and records filenames", async () => {
        await withTree(async (root) => {
            writeMigration(root, "20261012235900.users.migration.ts", ["SELECT 1"], ["SELECT 0"])
            writeMigration(root, "20261012235901.users.migration.ts", ["SELECT 2"], ["SELECT -2"])
            writeMigration(root, "20261012235900.orders.migration.ts", ["SELECT 9"], ["SELECT -9"])
            writeText(root, "notes.migration.ts", "export const upSql = []")
            writeText(root, "node_modules/pkg/20261012235900.hidden.migration.ts", "export const upSql = []")

            const found = discoverMigrationFiles(root, "users").map((file) => file.filename)
            assert.deepEqual(found, ["20261012235900.users.migration.ts", "20261012235901.users.migration.ts"])

            const db = new MemorySql()
            const first = await applyPendingMigrations({ query: db.query, migrationsDir: root, component: "users" })

            assert.deepEqual(first.applied, ["20261012235900.users.migration.ts", "20261012235901.users.migration.ts"])
            assert.deepEqual(first.skipped, [])
            assert.deepEqual([...db.applied], first.applied)
            assert.ok(db.statements.some((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}`)))
            assert.ok(db.statements.includes("SELECT 1"))
            assert.ok(db.statements.includes("SELECT 2"))
            assert.equal(db.statements.indexOf("SELECT 1") < db.statements.indexOf("SELECT 2"), true)

            const second = await applyPendingMigrations({ query: db.query, migrationsDir: root, component: "users" })

            assert.deepEqual(second.applied, [])
            assert.deepEqual(second.skipped, first.applied)

            const down = await applyPendingMigrations({ query: db.query, migrationsDir: root, component: "users", direction: "down" })

            assert.deepEqual(down.applied, ["20261012235901.users.migration.ts"])
            assert.ok(db.statements.includes("SELECT -2"))
            assert.equal(db.applied.has("20261012235901.users.migration.ts"), false)
            assert.equal(db.applied.has("20261012235900.users.migration.ts"), true)
        })
    })

    it("does not record a filename when up fails", async () => {
        await withTree(async (root) => {
            writeMigration(root, "20261012235900.users.migration.ts", ["SELECT 1"], ["SELECT 0"])
            writeMigration(root, "20261012235901.users.migration.ts", ["BOOM"], ["SELECT 0"])

            const db = new MemorySql()

            await assert.rejects(() => applyPendingMigrations({ query: db.query, migrationsDir: root, component: "users" }), /BOOM/)
            assert.deepEqual([...db.applied], ["20261012235900.users.migration.ts"])
        })
    })

    it("converts a missing table in SQL from the target schema", async () => {
        await withTree(async (root) => {
            const db = new MemorySql()
            const result = await migrateComponentToSchema({
                query: db.query,
                component: "users",
                schema: defaultSchema,
                migrationsDir: root,
                timestamp: "20261012235900"
            })

            assert.equal(result.table, "users")
            assert.equal(result.migrationPath, path.join(root, "20261012235900.users.migration.ts"))
            assert.deepEqual(result.run.applied, ["20261012235900.users.migration.ts"])
            assert.ok(db.tables.has("users"))
            assert.equal(db.tables.get("users")?.get("data"), "jsonb")
            assert.ok(db.tables.has("users_history"))

            const again = await migrateComponentToSchema({
                query: db.query,
                component: "users",
                schema: defaultSchema,
                migrationsDir: root,
                timestamp: "20261012235999"
            })

            assert.equal(again.migrationPath, undefined)
            assert.deepEqual(again.run.applied, [])
            assert.deepEqual(again.run.skipped, ["20261012235900.users.migration.ts"])
        })
    })

    it("loads up/down SQL from a generated migration file", async () => {
        const source = renderMigrationFile("20261012235900.users.migration.ts", "users", {
            up: ["CREATE TABLE IF NOT EXISTS users(id serial PRIMARY KEY)"],
            down: ["DROP TABLE IF EXISTS users, users_history"]
        })

        assert.deepEqual(extractExportedStringArray(source, "upSql"), ["CREATE TABLE IF NOT EXISTS users(id serial PRIMARY KEY)"])
        assert.match(source, /export async function up/)
        assert.match(source, /export async function down/)

        await withTree(async (root) => {
            const file = writeMigrationFile({
                directory: root,
                component: "users",
                statements: { up: ["SELECT 1"], down: ["SELECT 0"] },
                timestamp: "20261012235900"
            })
            const loaded = loadMigrationModule(file)
            assert.deepEqual(loaded.upSql, ["SELECT 1"])
            assert.deepEqual(loaded.downSql, ["SELECT 0"])
        })
    })
})

describe("CLI", () => {
    it("accepts <component> <schema-path> and a run or generate flag", () => {
        const parsed = parseMigrateArgs(["users", "./components/users/users.schema.json", "--generate", "--out-dir", "/tmp/out"])

        assert.equal(parsed.component, "users")
        assert.equal(parsed.mode, "generate")
        assert.equal(parsed.direction, "up")
        assert.equal(parsed.outDir, path.resolve("/tmp/out"))
        assert.equal(parseMigrateArgs(["users", "schema.json"]).mode, "run")
        assert.equal(parseMigrateArgs(["users", "schema.json", "--run", "--down"]).direction, "down")
        assert.throws(() => parseMigrateArgs(["users"]), new RegExp(escapeRegExp(MIGRATE_USAGE)))
        assert.throws(() => parseMigrateArgs(["users", "schema.json", "--run", "--generate"]), /Choose one mode/)
        assert.throws(() => parseMigrateArgs(["users", "schema.json", "--generate", "--down"]), /only valid with --run/)
        assert.throws(() => parseMigrateArgs(["users", "schema.json", "--wat"]), /Unknown option/)
    })

    it("generate mode writes a Flight-consumable route and no Express import", async () => {
        await withTree(async (root) => {
            const schemaPath = writeJson(root, "users.schema.json", {
                properties: {
                    data: { type: "object" },
                    email: { type: "string" }
                }
            })

            const result = await executeMigrate({
                component: "users",
                schemaPath,
                mode: "generate",
                direction: "up",
                outDir: root,
                migrationsDir: root
            })

            assert.equal(result.routePath, path.join(root, "users.migration.backend.ts"))
            assert.ok(result.migrationPath?.endsWith(".users.migration.ts"))

            const route = readFileSync(result.routePath ?? "", "utf8")
            assert.match(route, /from "@koa\/router"/)
            assert.match(route, /router\.post\("\/users\/migrate"/)
            assert.match(route, /export default router\.routes\(\)/)
            assert.match(route, /@thoughtpivot\/scribe\/migrations/)
            assert.equal(/from ["']express["']/.test(route), false)
            assert.equal(/require\(["']express["']\)/.test(route), false)

            const rendered = renderMigrationRouteFile("users")
            assert.equal(/from ["']express["']/.test(rendered), false)
            assert.match(rendered, /applyPendingMigrations/)
        })
    })

    it("run mode converts the table in SQL through the shared runner", async () => {
        await withTree(async (root) => {
            const schemaPath = writeJson(root, "users.schema.json", defaultSchema)
            const db = new MemorySql()

            const first = await executeMigrate(
                {
                    component: "users",
                    schemaPath,
                    mode: "run",
                    direction: "up",
                    outDir: root,
                    migrationsDir: root
                },
                { query: db.query }
            )

            assert.equal(first.run.applied.length, 1)
            assert.ok(db.tables.has("users"))
            assert.equal(first.routePath, undefined)

            const second = await executeMigrate(
                {
                    component: "users",
                    schemaPath,
                    mode: "run",
                    direction: "up",
                    outDir: root,
                    migrationsDir: root
                },
                { query: db.query }
            )

            assert.deepEqual(second.run.applied, [])
            assert.equal(second.run.skipped.length, 1)
        })
    })

    it("adds a new schema column to an existing table on run", async () => {
        await withTree(async (root) => {
            const db = new MemorySql()
            db.tables.set(
                "users",
                new Map([
                    ["id", "integer"],
                    ["data", "jsonb"]
                ])
            )

            const schemaPath = writeJson(root, "users.schema.json", {
                properties: {
                    data: { type: "object" },
                    email: { type: "string" }
                }
            })

            const result = await executeMigrate(
                {
                    component: "users",
                    schemaPath,
                    mode: "run",
                    direction: "up",
                    outDir: root,
                    migrationsDir: root
                },
                { query: db.query }
            )

            assert.equal(result.run.applied.length, 1)
            assert.equal(db.tables.get("users")?.get("email"), "text")
            assert.match(result.plan.changes.map((change) => change.kind).join(","), /add_column/)
        })
    })

    it("records applied filenames in Postgres when the database is available", async (t) => {
        const db = openMigrationConnection({
            host: process.env.SCRIBE_APP_DB_HOST ?? "127.0.0.1",
            port: Number(process.env.SCRIBE_APP_DB_PORT ?? 5432),
            user: process.env.SCRIBE_APP_DB_USER ?? "postgres",
            password: process.env.SCRIBE_APP_DB_PASS ?? "postgres",
            database: process.env.SCRIBE_APP_DB_NAME ?? "postgres"
        })

        try {
            await db.query("SELECT 1")
        } catch {
            t.skip("Postgres is not available")
            await db.close()
            return
        }

        const table = `tho245_${Date.now()}`

        try {
            await withTree(async (root) => {
                const schemaPath = writeJson(root, `${table}.schema.json`, {
                    properties: { data: { type: "object" }, email: { type: "string" } }
                })

                const first = await executeMigrate(
                    {
                        component: table,
                        schemaPath,
                        mode: "run",
                        direction: "up",
                        outDir: root,
                        migrationsDir: root
                    },
                    { query: db.query, close: async () => undefined }
                )

                assert.equal(first.run.applied.length, 1)
                const recorded = await listAppliedFilenames(db.query)
                assert.ok(recorded.includes(first.run.applied[0]))

                const cols = (await db.query(
                    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
                    [table]
                )) as Array<{ column_name: string }>

                assert.ok(cols.some((column) => column.column_name === "email"))

                const second = await executeMigrate(
                    {
                        component: table,
                        schemaPath,
                        mode: "run",
                        direction: "up",
                        outDir: root,
                        migrationsDir: root
                    },
                    { query: db.query, close: async () => undefined }
                )

                assert.deepEqual(second.run.applied, [])
            })
        } finally {
            await db.query(`DROP TABLE IF EXISTS ${table}, ${table}_history`)
            await db.close()
        }
    })

    it("keeps the migrate path free of Express imports", () => {
        const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src")
        const files = ["migrations.ts", "migrations-cli.ts"].map((name) => readFileSync(path.join(srcDir, name), "utf8"))

        for (const source of files) {
            assert.equal(/from ["']express["']/.test(source), false)
            assert.equal(/require\(["']express["']\)/.test(source), false)
        }
    })
})

class MemorySql {
    public applied = new Set<string>()
    public tables = new Map<string, Map<string, string>>()
    public statements: string[] = []

    public query: SqlQuery = async (sql, values) => {
        const text = sql.replace(/\s+/g, " ").trim()
        this.statements.push(text)

        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return []

        if (/CREATE TABLE IF NOT EXISTS scribe_migrations/i.test(text)) return []

        if (/SELECT filename FROM scribe_migrations/i.test(text)) return [...this.applied].sort().map((filename) => ({ filename }))

        if (/INSERT INTO scribe_migrations/i.test(text)) {
            const filename = String(values?.[0])
            if (filename === "BOOM" || text.includes("BOOM")) throw new Error("BOOM")

            this.applied.add(filename)
            return []
        }

        if (/DELETE FROM scribe_migrations/i.test(text)) {
            this.applied.delete(String(values?.[0]))
            return []
        }

        if (/FROM information_schema.columns/i.test(text)) {
            const cols = this.tables.get(String(values?.[0]).toLowerCase())
            if (!cols) return []

            return [...cols.entries()].map(([column_name, udt_name]) => ({ column_name, data_type: udt_name, udt_name }))
        }

        if (text === "BOOM" || text.includes("BOOM")) throw new Error("BOOM")

        const created = /^CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/i.exec(text)

        if (created) {
            const table = created[1].toLowerCase()
            if (this.tables.has(table)) return []

            const cols = new Map<string, string>()

            for (const part of created[2].split(",")) {
                const tokens = part.trim().split(/\s+/)
                const name = tokens[0]
                if (!name || name.toLowerCase() === "foreignkey") continue

                cols.set(name.toLowerCase(), name.toLowerCase() === "id" ? "integer" : tokens[1] ?? "text")
            }

            this.tables.set(table, cols)
            return []
        }

        const added = /^ALTER TABLE ([A-Za-z_][A-Za-z0-9_]*) ADD COLUMN IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*) (\S+)/i.exec(text)

        if (added) {
            const cols = this.tables.get(added[1].toLowerCase()) ?? new Map<string, string>()
            cols.set(added[2].toLowerCase(), added[3])
            this.tables.set(added[1].toLowerCase(), cols)
            return []
        }

        const droppedCol = /^ALTER TABLE ([A-Za-z_][A-Za-z0-9_]*) DROP COLUMN IF EXISTS ([A-Za-z_][A-Za-z0-9_]*)/i.exec(text)

        if (droppedCol) {
            this.tables.get(droppedCol[1].toLowerCase())?.delete(droppedCol[2].toLowerCase())
            return []
        }

        const altered = /^ALTER TABLE ([A-Za-z_][A-Za-z0-9_]*) ALTER COLUMN ([A-Za-z_][A-Za-z0-9_]*) TYPE (\S+)/i.exec(text)

        if (altered) {
            this.tables.get(altered[1].toLowerCase())?.set(altered[2].toLowerCase(), altered[3])
            return []
        }

        const dropped = /^DROP TABLE IF EXISTS ([A-Za-z_][A-Za-z0-9_]*)/i.exec(text)

        if (dropped) this.tables.delete(dropped[1].toLowerCase())

        return []
    }
}

/**
 * @param filename
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * @param run
 */
async function withTree(run: (root: string) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "scribe-migrate-"))

    try {
        await run(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

/**
 * @param root
 * @param filename
 * @param up
 * @param down
 */
function writeMigration(root: string, filename: string, up: string[], down: string[]): void {
    writeText(root, filename, renderMigrationFile(filename, parseMigrationFilename(filename)?.component ?? "users", { up, down }))
}

/**
 * @param root
 * @param rel
 * @param schema
 */
function writeJson(root: string, rel: string, schema: object): string {
    writeText(root, rel, JSON.stringify(schema))
    return path.join(root, rel)
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
