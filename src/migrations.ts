/**
 * Migrations table and runner.
 * Runtime-neutral: Node (`scribe`) and Bun (`scribe-bun`) both reach this through core.
 * No Express. The filename is the identity. Package versions are not.
 */
import { existsSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import pgPromise from "pg-promise"

const require = createRequire(import.meta.url)
const fg = require("fast-glob") as typeof import("fast-glob")

/** Record of applied migration filenames. `filename` is the primary key. */
export const MIGRATIONS_TABLE = "scribe_migrations"

const MIGRATION_GLOBS = ["**/*.migration.ts", "**/*.migration.js", "**/*.migration.mjs"]
const BUILTIN_IGNORES = ["**/node_modules/**", "**/.git/**"]

export type MigrationDb = pgPromise.IBaseProtocol<Record<string, never>>

export type MigrationUp = (db: MigrationDb) => Promise<void>

export interface MigrationStep {
    filename: string
    up: MigrationUp
}

export interface MigrationRunResult {
    applied: string[]
}

/**
 * Create the migrations table when it is missing.
 * Columns are the filename and the time it was recorded. There is no version column.
 *
 * @param db connection or transaction
 */
export async function ensureMigrationsTable(db: MigrationDb): Promise<void> {
    await db.none(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )`
    )
}

/**
 * Filenames already recorded, in filename order.
 *
 * @param db connection or transaction
 */
export async function appliedMigrationFilenames(db: MigrationDb): Promise<string[]> {
    await ensureMigrationsTable(db)
    const rows = await db.any<{ filename: string }>(`SELECT filename FROM ${MIGRATIONS_TABLE} ORDER BY filename`)

    return rows.map((row) => row.filename)
}

/**
 * Absolute paths of migration files under `directory`, sorted by filename.
 * Duplicate filenames are rejected. A missing directory yields no files.
 *
 * @param directory root to scan
 */
export function discoverMigrationFiles(directory: string): string[] {
    const root = path.resolve(directory)

    if (!existsSync(root) || !statSync(root).isDirectory()) return []

    const relative = fg.sync(MIGRATION_GLOBS, {
        cwd: root,
        onlyFiles: true,
        dot: false,
        ignore: BUILTIN_IGNORES
    })

    const files = relative.map((rel) => path.resolve(root, rel))

    files.sort((left, right) => compareFilenames(path.basename(left), path.basename(right)) || compareFilenames(left, right))

    const seen = new Set<string>()

    for (const file of files) {
        const filename = path.basename(file)

        if (seen.has(filename)) throw new Error(`Duplicate migration filename ${filename}`)

        seen.add(filename)
    }

    return files
}

/**
 * Load the `up` function from a migration module.
 *
 * @param filePath absolute or relative path
 */
export async function loadMigrationUp(filePath: string): Promise<MigrationUp> {
    const imported = (await import(pathToFileURL(filePath).href)) as { up?: unknown }
    const up = imported.up

    if (typeof up !== "function") throw new Error(`Migration ${path.basename(filePath)} does not export up`)

    return up as MigrationUp
}

/**
 * Run pending steps in the order given. Record each filename only after `up` succeeds.
 * A failure stops the run. Filenames already stored are not executed again.
 *
 * @param db connection
 * @param migrations steps in the order they should run
 */
export async function applyMigrations(db: MigrationDb, migrations: readonly MigrationStep[]): Promise<string[]> {
    await ensureMigrationsTable(db)
    const done = new Set(await appliedMigrationFilenames(db))
    const applied: string[] = []

    for (const migration of migrations) {
        if (done.has(migration.filename)) continue

        await db.tx(async (task) => {
            await migration.up(task)
            await task.none(`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`, [migration.filename])
        })

        applied.push(migration.filename)
        done.add(migration.filename)
    }

    return applied
}

/**
 * Discover migration files, run pending `up` steps in filename order, and record successes.
 *
 * @param db connection
 * @param directory root that contains migration files
 */
export async function runMigrations(db: MigrationDb, directory: string): Promise<MigrationRunResult> {
    await ensureMigrationsTable(db)
    const done = new Set(await appliedMigrationFilenames(db))
    const pending: MigrationStep[] = []

    for (const file of discoverMigrationFiles(directory)) {
        const filename = path.basename(file)

        if (done.has(filename)) continue

        pending.push({
            filename,
            up: await loadMigrationUp(file)
        })
    }

    return {
        applied: await applyMigrations(db, pending)
    }
}

/**
 * @param left
 * @param right
 */
function compareFilenames(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1

    return 0
}
