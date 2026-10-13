#!/usr/bin/env node

const command = process.argv[2]

if (command === "generate" || command === "run") {
    const { migrationCommand } = await import("./migrations.cli.js")

    migrationCommand(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
    })
} else {
    const { default: cluster } = await import("node:cluster")
    const os = await import("node:os")
    const { createServer, tryCreateDb } = await import("./scribe.js")

    if (cluster.isPrimary) {
        tryCreateDb()
            .then(() => {
                const cores = os.cpus()

                for (let i = 0; i < cores.length; i++) cluster.fork()

                cluster.on("exit", (worker) => {
                    cluster.fork()
                })
            })
            .catch((error) => {
                throw error
            })
    } else {
        createServer()
    }
}
