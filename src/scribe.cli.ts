#!/usr/bin/env node
import cluster from "node:cluster"
import os from "os"

/**
 * `scribe migrate <component> <schema-path>` converts a table from core/CLI.
 * The default command still starts the Node server.
 */
if (process.argv[2] === "migrate") {
    const { runMigrateCommand } = await import("./migrations-cli.js")

    try {
        await runMigrateCommand(process.argv.slice(3))
    } catch (error) {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
    }
} else if (cluster.isPrimary) {
    const { tryCreateDb } = await import("./core.js")

    tryCreateDb()
        .then(() => {
            const cores = os.cpus()

            for (let i = 0; i < cores.length; i++) cluster.fork()

            cluster.on("exit", () => {
                cluster.fork()
            })
        })
        .catch((error) => {
            throw error
        })
} else {
    const { createServer } = await import("./scribe.js")

    await createServer()
}
