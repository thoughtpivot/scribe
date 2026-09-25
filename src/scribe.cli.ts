#!/usr/bin/env node
import cluster from "cluster"
import os from "os"

import { getErrorMessage } from "./errors.js"
import { createServer, tryCreateDb } from "./scribe.js"

if (cluster.isPrimary) {
    tryCreateDb()
        .then(() => {
            const cores = os.cpus()

            for (let i = 0; i < cores.length; i++) cluster.fork()

            cluster.on("exit", (worker) => {
                console.error(`Worker ${worker.process.pid} exited. Starting a replacement.`)
                cluster.fork()
            })
        })
        .catch((error) => {
            console.error(getErrorMessage(error))
            process.exit(1)
        })
} else {
    createServer()
}
