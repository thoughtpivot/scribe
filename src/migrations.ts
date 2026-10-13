/**
 * Schema-driven migrations table and runner.
 * Runtime-neutral: Node (`scribe`) and Bun (`scribe-bun`) share this from core and the CLI.
 * No Express. Identity is the migration filename, not a semantic-release version.
 */
import { DateTime } from "luxon"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import pgPromise from "pg-promise"

const require = createRequire(import.meta.url)
const fg = require("fast-glob") as typeof import("fast-glob")

export const MIGRATIONS_TABLE = "scribe_migrations"
export const MIGRATION_SUFFIX = ".migration.ts"
export const ROUTE_SUFFIX = ".migration.backend.ts"

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const BUILTIN_IGNORES = ["**/node_modules/**", "**/.git/**"]
const MIGRATION_FILENAME = /^(\d+)\.([A-Za-z_][A-Za-z0-9_]*)\.migration\.ts$/

export type SqlQuery = (sql: string, values?: unknown[]) => Promise<unknown>
export type MigrationDirection = "up" | "down"

export interface PostgresConnectionConfig {
    host: string
    port: number
    user: string
    password: string
    database: string
    ssl?: { rejectUnauthorized: boolean }
}

export interface MigrationConnection {
    query: SqlQuery
    close: () => Promise<void>
}

export interface ParsedMigrationFilename {
    filename: string
    timestamp: string
    component: string
}

export interface DiscoveredMigration extends ParsedMigrationFilename {
    path: string
}

export interface LiveColumn {
    name: string
    sqlType: string
}

export interface SchemaColumn {
    name: string
    sqlType: string
}

export type SchemaChange =
    | { kind: "create_table"; table: string; columns: SchemaColumn[] }
    | { kind: "add_column"; table: string; column: SchemaColumn }
    | { kind: "alter_column"; table: string; column: SchemaColumn; from: string }

export interface SchemaPlan {
    table: string
    changes: SchemaChange[]
}

export interface SqlStatements {
    up: string[]
    down: string[]
}

export interface LoadedMigration {
    filename: string
    component: string
    upSql: string[]
    downSql: string[]
    up: (query: SqlQuery) => Promise<void>
    down: (query: SqlQuery) => Promise<void>
}

export interface MigrationRunResult {
    direction: MigrationDirection
    applied: string[]
    skipped: string[]
}

export interface MigrateComponentResult {
    table: string
    plan: SchemaPlan
    migrationPath?: string
    routePath?: string
    run: MigrationRunResult
}

/**
 * @param err
 */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/**
 * Postgres table name for a Scribe component. Slashes become underscores so
 * `Users/Profile` matches the `Users_Profile` table the write routes use.
 *
 * @param component
 */
export function tableNameFromComponent(component: string): string {
    const trimmed = component.trim()
    if (!trimmed) throw new Error("Component name is required")

    const table = trimmed.replace(/\//g, "_")
    return assertSafeSqlName(table, "component")
}

/**
 * File stem used in `{timestamp}.{component}.migration.ts` and `{component}.migration.backend.ts`.
 *
 * @param component
 */
export function fileStemFromComponent(component: string): string {
    return tableNameFromComponent(component)
}

/**
 * @param name
 * @param label
 */
export function assertSafeSqlName(name: string, label: string): string {
    if (!SAFE_IDENT.test(name)) throw new Error(`Invalid ${label}: ${name}`)

    return name
}

/**
 * @param filename
 */
export function parseMigrationFilename(filename: string): ParsedMigrationFilename | undefined {
    const base = path.basename(filename)
    const match = MIGRATION_FILENAME.exec(base)
    if (!match) return undefined

    return {
        filename: base,
        timestamp: match[1],
        component: match[2]
    }
}

/**
 * @param timestamp
 * @param component
 */
export function migrationFilename(timestamp: string, component: string): string {
    return `${timestamp}.${fileStemFromComponent(component)}${MIGRATION_SUFFIX}`
}

/**
 * Flight-consumable REST route filename for a component (`users` → `users.migration.backend.ts`).
 *
 * @param component
 */
export function routeFilename(component: string): string {
    return `${fileStemFromComponent(component)}${ROUTE_SUFFIX}`
}

/**
 * UTC timestamp used as the ordering prefix. Lexicographic filename order is chronological.
 *
 * @param now
 */
export function migrationTimestamp(now: Date = new Date()): string {
    return DateTime.fromJSDate(now, { zone: "utc" }).toFormat("yyyyMMddHHmmss")
}

/**
 * @param left
 * @param right
 */
export function compareMigrationFilenames(left: string, right: string): number {
    return path.basename(left) < path.basename(right) ? -1 : path.basename(left) > path.basename(right) ? 1 : 0
}

/**
 * Map a JSON Schema property to the Postgres type `formatQueryData` uses.
 *
 * @param property
 */
export function jsonSchemaTypeToSql(property: unknown): string | undefined {
    if (typeof property !== "object" || property === null) return undefined

    const schema = property as { type?: unknown; format?: unknown }
    const type = schema.type

    if (type === "integer") return "integer"

    if (type === "number") return "float8"

    if (type === "boolean") return "boolean"

    if (type === "object" || type === "array") return "jsonb"

    if (type === "string") return schema.format === "date-time" ? "timestamptz" : "text"

    return undefined
}

/**
 * Fold information_schema / udt names onto the types this runner emits.
 *
 * @param type
 */
export function normalizeSqlType(type: string): string {
    const value = type.trim().toLowerCase()

    if (value === "int" || value === "int4" || value === "serial" || value === "integer") return "integer"

    if (value === "int8" || value === "bigint" || value === "bigserial") return "bigint"

    if (value === "float8" || value === "double precision" || value === "float" || value === "numeric" || value === "decimal") return "float8"

    if (value === "bool" || value === "boolean") return "boolean"

    if (value === "json" || value === "jsonb") return "jsonb"

    if (value === "timestamptz" || value === "timestamp with time zone") return "timestamptz"

    if (value === "timestamp" || value === "timestamp without time zone") return "timestamp"

    if (value === "character varying" || value === "varchar" || value === "character" || value === "char" || value === "text") return "text"

    return value
}

/**
 * @param schema
 */
export function columnsFromJsonSchema(schema: object): SchemaColumn[] {
    const properties = (schema as { properties?: unknown }).properties
    if (typeof properties !== "object" || properties === null) return []

    const columns: SchemaColumn[] = []

    for (const [name, property] of Object.entries(properties)) {
        if (name === "id") continue

        const sqlType = jsonSchemaTypeToSql(property)
        if (!sqlType) continue

        columns.push({ name: assertSafeSqlName(name, "column"), sqlType })
    }

    return columns
}

/**
 * Compare live Postgres columns to the target JSON Schema. Additive and type changes only.
 *
 * @param table
 * @param live
 * @param schema
 */
export function diffTableAgainstSchema(table: string, live: LiveColumn[], schema: object): SchemaPlan {
    const safeTable = assertSafeSqlName(table, "table")
    const wanted = columnsFromJsonSchema(schema)
    const liveByName = new Map(live.map((column) => [column.name.toLowerCase(), normalizeSqlType(column.sqlType)]))
    const hasTable = live.length > 0
    const changes: SchemaChange[] = []

    if (!hasTable) {
        changes.push({ kind: "create_table", table: safeTable, columns: wanted })
        return { table: safeTable, changes }
    }

    for (const column of wanted) {
        const current = liveByName.get(column.name.toLowerCase())

        if (!current) {
            changes.push({ kind: "add_column", table: safeTable, column })
            continue
        }

        if (current !== normalizeSqlType(column.sqlType)) changes.push({ kind: "alter_column", table: safeTable, column, from: current })
    }

    return { table: safeTable, changes }
}

/**
 * @param plan
 */
export function sqlForPlan(plan: SchemaPlan): SqlStatements {
    const up: string[] = []
    const down: string[] = []
    const table = plan.table
    const history = `${table}_history`

    for (const change of plan.changes) {
        if (change.kind === "create_table") {
            const columnSql = ["id serial PRIMARY KEY", ...change.columns.map((column) => `${column.name} ${column.sqlType}`)]

            up.push(`CREATE TABLE IF NOT EXISTS ${table}(${columnSql.join(", ")})`)
            up.push(
                `CREATE TABLE IF NOT EXISTS ${history}(id serial PRIMARY KEY, foreignKey integer REFERENCES ${table} (id) ON DELETE CASCADE, patches json)`
            )

            down.unshift(`DROP TABLE IF EXISTS ${table}, ${history}`)
            continue
        }

        if (change.kind === "add_column") {
            up.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${change.column.name} ${change.column.sqlType}`)
            down.unshift(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${change.column.name}`)
            continue
        }

        up.push(`ALTER TABLE ${table} ALTER COLUMN ${change.column.name} TYPE ${change.column.sqlType}`)
        down.unshift(`ALTER TABLE ${table} ALTER COLUMN ${change.column.name} TYPE ${change.from}`)
    }

    return { up, down }
}

/**
 * @param source
 * @param name
 */
export function extractExportedStringArray(source: string, name: string): string[] | undefined {
    const marker = `export const ${name} =`
    const start = source.indexOf(marker)
    if (start < 0) return undefined

    const open = source.indexOf("[", start + marker.length)
    if (open < 0) return undefined

    let depth = 0
    let end = -1

    for (let i = open; i < source.length; i++) {
        const ch = source[i]
        if (ch === "[") {
            depth++
        } else if (ch === "]") {
            depth--
            if (depth === 0) {
                end = i
                break
            }
        }
    }

    if (end < 0) return undefined

    return JSON.parse(source.slice(open, end + 1)) as string[]
}

/**
 * @param filename
 * @param component
 * @param statements
 */
export function renderMigrationFile(filename: string, component: string, statements: SqlStatements): string {
    const stem = fileStemFromComponent(component)

    return `/**
 * Schema migration for ${stem}.
 * Filename is the unique key stored in ${MIGRATIONS_TABLE}.
 */
export const filename = ${JSON.stringify(filename)}
export const component = ${JSON.stringify(stem)}

export const upSql = ${JSON.stringify(statements.up, null, 4)}

export const downSql = ${JSON.stringify(statements.down, null, 4)}

/**
 * @param query
 */
export async function up(query) {
    for (const statement of upSql) await query(statement)
}

/**
 * @param query
 */
export async function down(query) {
    for (const statement of downSql) await query(statement)
}
`
}

/**
 * Complete Flight `*.backend.ts` route. Koa only — no Express.
 *
 * @param component
 */
export function renderMigrationRouteFile(component: string): string {
    const stem = fileStemFromComponent(component)
    const route = `/${stem}/migrate`

    return `/**
 * Flight-consumable migration route for ${stem}.
 * Generated by \`scribe migrate ${stem} <schema-path> --generate\`.
 * Mounted when Flight discovers **/*.backend.ts. No Express.
 */
import Router from "@koa/router"

import { applyPendingMigrations, openMigrationConnection } from "@thoughtpivot/scribe/migrations"

const COMPONENT = ${JSON.stringify(stem)}

const router = new Router()

router.post(${JSON.stringify(route)}, async (ctx) => {
    const direction = ctx.query.direction === "down" ? "down" : "up"
    const db = await openMigrationConnection()

    try {
        ctx.body = await applyPendingMigrations({
            query: db.query,
            migrationsDir: process.cwd(),
            component: COMPONENT,
            direction
        })
        ctx.status = 200
    } catch (err) {
        ctx.status = 500
        ctx.body = { error: err instanceof Error ? err.message : String(err) }
    } finally {
        await db.close()
    }
})

export default router.routes()
`
}

/**
 * @param filePath
 */
export function loadMigrationModule(filePath: string): LoadedMigration {
    const source = readFileSync(filePath, "utf8")
    const parsed = parseMigrationFilename(filePath)
    if (!parsed) throw new Error(`Not a migration filename: ${path.basename(filePath)}`)

    const upSql = extractExportedStringArray(source, "upSql") ?? []
    const downSql = extractExportedStringArray(source, "downSql") ?? []

    return {
        filename: parsed.filename,
        component: parsed.component,
        upSql,
        downSql,
        up: async (query) => {
            for (const statement of upSql) await query(statement)
        },
        down: async (query) => {
            for (const statement of downSql) await query(statement)
        }
    }
}

/**
 * Find `{timestamp}.{component}.migration.ts` files and return them in deterministic filename order.
 *
 * @param root
 * @param component
 */
export function discoverMigrationFiles(root: string, component?: string): DiscoveredMigration[] {
    const abs = path.resolve(root || ".")
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return []

    let files: string[]

    try {
        files = fg.sync(`**/*${MIGRATION_SUFFIX}`, {
            cwd: abs,
            onlyFiles: true,
            dot: false,
            ignore: BUILTIN_IGNORES
        })
    } catch (err) {
        console.warn(`Scribe: migration discovery failed under ${abs}: ${errorText(err)}`)
        return []
    }

    const wanted = component ? fileStemFromComponent(component) : undefined
    const found: DiscoveredMigration[] = []

    for (const rel of files) {
        const parsed = parseMigrationFilename(rel)
        if (!parsed) continue

        if (wanted && parsed.component !== wanted) continue

        found.push({
            ...parsed,
            path: path.resolve(abs, rel)
        })
    }

    found.sort((left, right) => compareMigrationFilenames(left.filename, right.filename))
    return found
}

/**
 * Create the migrations table that records applied filenames. Filename is the unique key.
 *
 * @param query
 */
export async function ensureMigrationsTable(query: SqlQuery): Promise<void> {
    await query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT NOW())`)
}

/**
 * @param query
 */
export async function listAppliedFilenames(query: SqlQuery): Promise<string[]> {
    const rows = (await query(`SELECT filename FROM ${MIGRATIONS_TABLE} ORDER BY filename`)) as Array<{ filename: string }>
    return rows.map((row) => row.filename)
}

/**
 * @param query
 * @param filename
 */
export async function recordAppliedFilename(query: SqlQuery, filename: string): Promise<void> {
    await query(`INSERT INTO ${MIGRATIONS_TABLE}(filename) VALUES($1) ON CONFLICT (filename) DO NOTHING`, [filename])
}

/**
 * @param query
 * @param filename
 */
export async function removeAppliedFilename(query: SqlQuery, filename: string): Promise<void> {
    await query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE filename = $1`, [filename])
}

/**
 * @param query
 * @param table
 */
export async function readLiveColumns(query: SqlQuery, table: string): Promise<LiveColumn[]> {
    const rows = (await query(
        `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1
         ORDER BY ordinal_position`,
        [table.toLowerCase()]
    )) as Array<{ column_name: string; data_type: string; udt_name: string }>

    return rows.map((row) => ({
        name: row.column_name,
        sqlType: row.udt_name || row.data_type
    }))
}

/**
 * @param query
 * @param work
 */
async function withTransaction(query: SqlQuery, work: () => Promise<void>): Promise<void> {
    await query("BEGIN")

    try {
        await work()
        await query("COMMIT")
    } catch (err) {
        try {
            await query("ROLLBACK")
        } catch {}

        throw err
    }
}

/**
 * Apply pending `up` files, or roll back the last recorded `down`, in filename order.
 * Already-recorded filenames are skipped. A failed step is not recorded.
 *
 * @param options
 * @param options.query
 * @param options.migrationsDir
 * @param options.component
 * @param options.direction
 */
export async function applyPendingMigrations(options: {
    query: SqlQuery
    migrationsDir: string
    component?: string
    direction?: MigrationDirection
}): Promise<MigrationRunResult> {
    const direction = options.direction ?? "up"
    const query = options.query

    await ensureMigrationsTable(query)

    const applied = new Set(await listAppliedFilenames(query))
    const files = discoverMigrationFiles(options.migrationsDir, options.component)

    if (direction === "down") {
        const recorded = files
            .filter((file) => applied.has(file.filename))
            .sort((left, right) => compareMigrationFilenames(right.filename, left.filename))

        if (recorded.length === 0) return { direction, applied: [], skipped: files.map((file) => file.filename) }

        const target = recorded[0]

        const loaded = loadMigrationModule(target.path)

        await withTransaction(query, async () => {
            await loaded.down(query)
            await removeAppliedFilename(query, target.filename)
        })

        return {
            direction,
            applied: [target.filename],
            skipped: files.filter((file) => file.filename !== target.filename).map((file) => file.filename)
        }
    }

    const pending = files.filter((file) => !applied.has(file.filename))
    const ran: string[] = []

    for (const file of pending) {
        const loaded = loadMigrationModule(file.path)

        await withTransaction(query, async () => {
            await loaded.up(query)
            await recordAppliedFilename(query, file.filename)
        })

        ran.push(file.filename)
    }

    return {
        direction,
        applied: ran,
        skipped: files.filter((file) => applied.has(file.filename)).map((file) => file.filename)
    }
}

/**
 * @param dir
 * @param filename
 * @param contents
 */
function writeTextFile(dir: string, filename: string, contents: string): string {
    mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, filename)
    writeFileSync(dest, contents)
    return dest
}

/**
 * @param options
 * @param options.directory
 * @param options.component
 * @param options.statements
 * @param options.timestamp
 */
export function writeMigrationFile(options: { directory: string; component: string; statements: SqlStatements; timestamp?: string }): string {
    const timestamp = options.timestamp ?? migrationTimestamp()
    const filename = migrationFilename(timestamp, options.component)
    return writeTextFile(options.directory, filename, renderMigrationFile(filename, options.component, options.statements))
}

/**
 * @param options
 * @param options.directory
 * @param options.component
 */
export function writeMigrationRouteFile(options: { directory: string; component: string }): string {
    const filename = routeFilename(options.component)
    return writeTextFile(options.directory, filename, renderMigrationRouteFile(options.component))
}

/**
 * Read a component JSON Schema document from disk.
 *
 * @param schemaPath
 */
export function readSchemaDocument(schemaPath: string): object {
    const abs = path.resolve(schemaPath)
    let parsed: unknown

    try {
        parsed = JSON.parse(readFileSync(abs, "utf8"))
    } catch (err) {
        throw new Error(`Failed to read schema at ${abs}: ${errorText(err)}`)
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Schema is not a JSON object: ${abs}`)

    return parsed
}

/**
 * Build a schema plan from live columns, or treat a missing table as empty.
 *
 * @param query
 * @param table
 * @param schema
 */
export async function planComponentMigration(query: SqlQuery | undefined, table: string, schema: object): Promise<SchemaPlan> {
    if (!query) return diffTableAgainstSchema(table, [], schema)

    try {
        return diffTableAgainstSchema(table, await readLiveColumns(query, table), schema)
    } catch (err) {
        console.warn(`Scribe: could not read live columns for ${table}: ${errorText(err)}`)
        return diffTableAgainstSchema(table, [], schema)
    }
}

/**
 * Write a migration file when the live table and target schema differ.
 *
 * @param options
 * @param options.plan
 * @param options.component
 * @param options.directory
 * @param options.timestamp
 */
export function writePlanMigration(options: { plan: SchemaPlan; component: string; directory: string; timestamp?: string }): string | undefined {
    const statements = sqlForPlan(options.plan)
    if (statements.up.length === 0) return undefined

    return writeMigrationFile({
        directory: options.directory,
        component: options.component,
        statements,
        timestamp: options.timestamp
    })
}

/**
 * Convert a component table to the target JSON Schema by writing and applying an up/down file.
 *
 * @param options
 * @param options.query
 * @param options.component
 * @param options.schema
 * @param options.migrationsDir
 * @param options.direction
 * @param options.timestamp
 */
export async function migrateComponentToSchema(options: {
    query: SqlQuery
    component: string
    schema: object
    migrationsDir: string
    direction?: MigrationDirection
    timestamp?: string
}): Promise<MigrateComponentResult> {
    const table = tableNameFromComponent(options.component)
    await ensureMigrationsTable(options.query)

    const plan = await planComponentMigration(options.query, table, options.schema)
    const migrationPath = writePlanMigration({
        plan,
        component: options.component,
        directory: options.migrationsDir,
        timestamp: options.timestamp
    })

    const run = await applyPendingMigrations({
        query: options.query,
        migrationsDir: options.migrationsDir,
        component: options.component,
        direction: options.direction
    })

    return { table, plan, migrationPath, run }
}

/**
 * Generate the Flight route (and a pending up/down file when the schema differs).
 *
 * @param options
 * @param options.component
 * @param options.schema
 * @param options.outDir
 * @param options.migrationsDir
 * @param options.query
 * @param options.timestamp
 */
export async function generateComponentMigration(options: {
    component: string
    schema: object
    outDir: string
    migrationsDir: string
    query?: SqlQuery
    timestamp?: string
}): Promise<MigrateComponentResult> {
    const table = tableNameFromComponent(options.component)
    const plan = await planComponentMigration(options.query, table, options.schema)
    const migrationPath = writePlanMigration({
        plan,
        component: options.component,
        directory: options.migrationsDir,
        timestamp: options.timestamp
    })

    const routePath = writeMigrationRouteFile({ directory: options.outDir, component: options.component })

    return {
        table,
        plan,
        migrationPath,
        routePath,
        run: { direction: "up", applied: [], skipped: [] }
    }
}

/**
 * Connection settings from `SCRIBE_APP_*`, matching the server defaults.
 *
 * @param overrides
 */
export function postgresConfigFromEnv(overrides: Partial<PostgresConnectionConfig> = {}): PostgresConnectionConfig {
    const sslEnv = process.env.SCRIBE_APP_USE_SSL
    const ssl = overrides.ssl ?? (sslEnv === "true" || sslEnv === "1" ? { rejectUnauthorized: false } : undefined)

    return {
        host: overrides.host ?? process.env.SCRIBE_APP_DB_HOST ?? "localhost",
        port: overrides.port ?? Number(process.env.SCRIBE_APP_DB_PORT || 5432),
        user: overrides.user ?? process.env.SCRIBE_APP_DB_USER ?? "",
        password: overrides.password ?? process.env.SCRIBE_APP_DB_PASS ?? "",
        database: overrides.database ?? process.env.SCRIBE_APP_DB_NAME ?? "scribe",
        ssl
    }
}

/**
 * Open a Postgres session for the runner. No Redis and no Express.
 *
 * @param overrides
 */
export function openMigrationConnection(overrides: Partial<PostgresConnectionConfig> = {}): MigrationConnection {
    const pgp = pgPromise({})
    const db = pgp(postgresConfigFromEnv(overrides))

    return {
        query: (sql, values) => db.query(sql, values),
        close: () => db.$pool.end()
    }
}
