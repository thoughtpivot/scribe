/**
 * `generate` and `run` for the scribe and scribe-bun binaries.
 * No Express. `run` applies pending files through the shared runner.
 */
import path from "node:path"
import yargs from "yargs"

import { generateMigration } from "./migration-file.js"
import { runMigrations } from "./migrations.js"
import { resolveAppHome } from "./schema-discovery.js"

export interface MigrationCliArgs {
    command: "generate" | "run"
    component?: string
    dir: string
    appHome: string
    timestamp?: string
}

/**
 * Parse `generate` / `run` without starting the HTTP server.
 *
 * @param args arguments after the binary name
 */
export function parseMigrationArgs(args: string[]): MigrationCliArgs {
    const parsed = yargs(args)
        .scriptName(process.versions.bun ? "scribe-bun" : "scribe")
        .command("generate <component>", "Scaffold a {timestamp}.{component}.migration.ts file with up and down", (builder) =>
            builder.positional("component", {
                type: "string",
                demandOption: true,
                describe: "Component name, for example Users or Users/Profile"
            })
        )
        .command("run", "Apply pending migrations in filename order")
        .option("dir", {
            type: "string",
            default: "migrations",
            describe: "Migration directory, relative to app_home unless absolute"
        })
        .option("app_home", {
            alias: "app-home",
            type: "string",
            describe: "Application root. Defaults to SCRIBE_APP_APP_HOME or the working directory"
        })
        .option("timestamp", {
            type: "string",
            describe: "UTC timestamp YYYYMMDDHHmmss for generate. Default is the current time"
        })
        .demandCommand(1, "Specify generate <component> or run")
        .strict()
        .exitProcess(false)
        .fail((message) => {
            throw new Error(message)
        })
        .parseSync()

    const command = String(parsed._[0] ?? "")

    if (command !== "generate" && command !== "run") throw new Error("Specify generate <component> or run")

    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined

    if (timestamp !== undefined && !/^\d{14}$/.test(timestamp)) throw new Error("timestamp must be YYYYMMDDHHmmss")

    const component = typeof parsed.component === "string" ? parsed.component : undefined

    if (command === "generate" && !component) throw new Error("Component name is required")

    return {
        command,
        component,
        dir: String(parsed.dir),
        appHome: resolveAppHome(parsed.app_home),
        timestamp
    }
}

/**
 * Directory scanned and written by the migration CLI.
 *
 * @param args parsed CLI args
 */
export function migrationDirectory(args: Pick<MigrationCliArgs, "appHome" | "dir">): string {
    return path.resolve(args.appHome, args.dir)
}

/**
 * @param timestamp YYYYMMDDHHmmss
 */
function dateFromTimestamp(timestamp: string): Date {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp)

    if (!match) throw new Error("timestamp must be YYYYMMDDHHmmss")

    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])))
}

/**
 * Run generate or run. generate writes a stub. run applies pending ups.
 *
 * @param args arguments after the binary name
 */
export async function migrationCommand(args: string[]): Promise<void> {
    const parsed = parseMigrationArgs(args)
    const directory = migrationDirectory(parsed)
    const bin = process.versions.bun ? "scribe-bun" : "scribe"

    if (parsed.command === "generate") {
        const now = parsed.timestamp ? dateFromTimestamp(parsed.timestamp) : new Date()
        const written = generateMigration({
            component: parsed.component ?? "",
            directory,
            now
        })

        console.log(`Wrote ${written.path}`)
        console.log(`Review it, then apply pending migrations with \`${bin} run\`.`)

        return
    }

    const { openDatabase, tryCreateDb } = await import("./core.js")

    await tryCreateDb()
    const db = await openDatabase()

    try {
        const result = await runMigrations(db, directory)

        if (result.applied.length === 0) console.log("No pending migrations.")
        else {
            for (const filename of result.applied) console.log(`Applied ${filename}`)
        }
    } finally {
        await db.$pool.end()
    }
}
