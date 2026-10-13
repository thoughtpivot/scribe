/**
 * `scribe migrate <component> <schema-path>` — schema-driven table conversion.
 * Lives next to the existing `scribe` entry. No Express.
 */
import dotenv from "dotenv"
import path from "node:path"

import {
    type MigrateComponentResult,
    type MigrationConnection,
    type MigrationDirection,
    type SqlQuery,
    generateComponentMigration,
    migrateComponentToSchema,
    openMigrationConnection,
    readSchemaDocument
} from "./migrations.js"

dotenv.config()

export type MigrateCliMode = "run" | "generate"

export interface MigrateCliOptions {
    component: string
    schemaPath: string
    mode: MigrateCliMode
    direction: MigrationDirection
    outDir: string
    migrationsDir: string
}

export const MIGRATE_USAGE = "Usage: scribe migrate <component> <schema-path> [--run|--generate] [--down] [--out-dir <dir>] [--migrations-dir <dir>]"

/**
 * Parse the arguments after `scribe migrate`.
 *
 * @param args
 */
export function parseMigrateArgs(args: string[]): MigrateCliOptions {
    const positionals: string[] = []
    let run = false
    let generate = false
    let down = false
    let outDir: string | undefined
    let migrationsDir: string | undefined

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === "--run") {
            run = true
            continue
        }

        if (arg === "--generate" || arg === "--generate-route") {
            generate = true
            continue
        }

        if (arg === "--down") {
            down = true
            continue
        }

        if (arg === "--out-dir" || arg === "--outDir") {
            outDir = requireValue(args, ++i, arg)
            continue
        }

        if (arg === "--migrations-dir" || arg === "--migrationsDir") {
            migrationsDir = requireValue(args, ++i, arg)
            continue
        }

        if (arg === "--help") throw new Error(MIGRATE_USAGE)

        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}\n${MIGRATE_USAGE}`)

        positionals.push(arg)
    }

    if (positionals.length < 2) throw new Error(MIGRATE_USAGE)

    if (run && generate) throw new Error(`Choose one mode: --run or --generate\n${MIGRATE_USAGE}`)

    if (down && generate) throw new Error("--down is only valid with --run")

    const resolvedOut = path.resolve(outDir ?? process.cwd())

    return {
        component: positionals[0],
        schemaPath: path.resolve(positionals[1]),
        mode: generate ? "generate" : "run",
        direction: down ? "down" : "up",
        outDir: resolvedOut,
        migrationsDir: path.resolve(migrationsDir ?? resolvedOut)
    }
}

/**
 * @param args
 * @param index
 * @param flag
 */
function requireValue(args: string[], index: number, flag: string): string {
    const value = args[index]
    if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}`)

    return value
}

/**
 * @param options
 * @param deps
 * @param deps.query
 * @param deps.close
 * @param deps.createDb
 * @param deps.openConnection
 */
export async function executeMigrate(
    options: MigrateCliOptions,
    deps: {
        query?: SqlQuery
        close?: () => Promise<void>
        createDb?: () => Promise<void>
        openConnection?: () => MigrationConnection
    } = {}
): Promise<MigrateComponentResult> {
    const schema = readSchemaDocument(options.schemaPath)

    if (options.mode === "generate") {
        let query = deps.query
        let close = deps.close ?? (async () => undefined)

        if (!query && deps.openConnection) {
            const connection = deps.openConnection()
            close = connection.close

            try {
                await connection.query("SELECT 1")
                query = connection.query
            } catch {
                await connection.close()
                close = async () => undefined
            }
        }

        try {
            return await generateComponentMigration({
                component: options.component,
                schema,
                outDir: options.outDir,
                migrationsDir: options.migrationsDir,
                query
            })
        } finally {
            await close()
        }
    }

    if (deps.createDb) await deps.createDb()

    const connection = deps.query
        ? { query: deps.query, close: deps.close ?? (async () => undefined) }
        : (deps.openConnection ?? openMigrationConnection)()

    try {
        return await migrateComponentToSchema({
            query: connection.query,
            component: options.component,
            schema,
            migrationsDir: options.migrationsDir,
            direction: options.direction
        })
    } finally {
        await connection.close()
    }
}

/**
 * CLI entry used by `scribe migrate`.
 *
 * @param args
 */
export async function runMigrateCommand(args: string[]): Promise<MigrateComponentResult> {
    const options = parseMigrateArgs(args)
    const core = await import("./core.js")
    const openConnection = () =>
        openMigrationConnection({
            host: String(core.argv.dbHost),
            port: Number(core.argv.dbPort),
            user: String(core.argv.dbUser),
            password: String(core.argv.dbPass),
            database: String(core.argv.dbName),
            ssl: core.argv.useSSL ? { rejectUnauthorized: false } : undefined
        })

    const createDb = options.mode === "run" ? () => core.tryCreateDb() : undefined

    const result = await executeMigrate(options, { createDb, openConnection })

    if (options.mode === "generate") {
        console.log(`Generated Flight route ${result.routePath}`)
        if (result.migrationPath) console.log(`Generated migration ${result.migrationPath}`)
        else console.log("No schema changes; route file only")
    } else if (result.run.applied.length === 0) {
        console.log(`No pending migrations for ${result.table}`)
    } else {
        console.log(`${result.run.direction === "down" ? "Rolled back" : "Applied"} ${result.run.applied.join(", ")}`)
    }

    return result
}
