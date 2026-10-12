import express from "express"
import { Server } from "http"
import { mkdirp } from "mkdirp"
import { createRequire } from "module"

import { argv, CoreResponse, createCore, rejectSqlBody, tryCreateDb } from "./core.js"

export { tryCreateDb }

const require = createRequire(import.meta.url)

/**
 *
 * @param res
 * @param result
 */
function writeCoreResponse(res: express.Response, result: CoreResponse): void {
    for (const effect of result.effects) {
        if (effect.op === "status") res.status(effect.code)
        else if (effect.op === "send") res.send(effect.body)
        else res.sendStatus(effect.code)
    }

    if (result.sendValue) res.send(result.value)
}

/**
 *
 * @param res
 * @param pending
 */
function deliver(res: express.Response, pending: Promise<CoreResponse>): void {
    pending.then((result) => {
        writeCoreResponse(res, result)
    })
}

/**
 * @param schemaOverride
 */
export async function createServer(schemaOverride: any = undefined): Promise<Server> {
    const core = await createCore(schemaOverride)
    const scribe = express()
    scribe.use(express.json({ limit: argv.payloadLimit }))

    if (argv.mode === "production") {
        mkdirp.sync(argv.home + "/cache/")
        mkdirp.sync(argv.home + "/logs/")

        scribe.use(
            require("express-bunyan-logger")({
                name: argv.name,
                streams: [
                    {
                        level: "error",
                        stream: process.stderr
                    },
                    {
                        level: "info",
                        type: "rotating-file",
                        path: argv.home + `/logs/${argv.name}.${process.pid}.json`,
                        period: "1d",
                        count: 365
                    }
                ]
            })
        )
    }

    // NOTE this is a super dangerous route, scribe is meant to only be listening inside a private vpc
    scribe.post("/sql", (req, res, next) => {
        const rejected = rejectSqlBody(req.body)
        if (rejected) {
            writeCoreResponse(res, rejected)
            return
        }

        deliver(res, core.runSql(req.body.query))
    })

    scribe.post("/:component/all", (req, res, next) => {
        // get all
        deliver(res, core.readAll(req.params.component, req.query, req.body))
        // fail if component doesn't exist
        // returns array always
    })

    scribe.post("/:component/:subcomponent/all", (req, res, next) => {
        // get all
        deliver(res, core.readAll(`${req.params.component}_${req.params.subcomponent}`, req.query, req.body))
        // fail if component doesn't exist
        // returns array always
    })

    scribe.post("/:component/:subcomponent", (req, res, next) => {
        deliver(
            res,
            core.createRecord(`${req.params.component}_${req.params.subcomponent}`, `${req.params.component}/${req.params.subcomponent}`, req.body)
        )
        // send response success or fail
    })

    scribe.post("/:component", (req, res, next) => {
        deliver(res, core.createRecord(req.params.component, req.params.component, req.body))

        // send response success or fail
    })

    scribe.get("/:component/:id/history", (req, res, next) => {
        deliver(res, core.readHistory(req.params.component, req.params.id))
    })

    scribe.get("/:component/:subcomponent/:id/history", (req, res, next) => {
        deliver(res, core.readHistory(`${req.params.component}_${req.params.subcomponent}`, req.params.id))
    })

    scribe.get("/:component/:subcomponent/all", (req, res, next) => {
        // get all
        deliver(res, core.readAll(`${req.params.component}_${req.params.subcomponent}`, req.query, req.body))
        // fail if component doesn't exist
        // returns array always
    })

    scribe.get("/:component/all", (req, res, next) => {
        // get all
        deliver(res, core.readAll(req.params.component, req.query, req.body))
        // fail if component doesn't exist
        // returns array always
    })

    scribe.get("/:component/:subcomponent/:id", (req, res, next) => {
        // get id
        deliver(res, core.readOne(`${req.params.component}_${req.params.subcomponent}`, req.params.id, req.query, req.body || {}))
        // fail if component doesn't exist
        // returns array always
    })

    scribe.get("/:component/:id", (req, res, next) => {
        // get id
        deliver(res, core.readOne(req.params.component, req.params.id, req.query, req.body || {}))
        // fail if component doesn't exist
        // returns array always
    })

    scribe.put("/:component/:subcomponent/:id", (req, res, next) => {
        deliver(
            res,
            core.updateRecord(
                `${req.params.component}_${req.params.subcomponent}`,
                `${req.params.component}/${req.params.subcomponent}`,
                req.params.id,
                req.body
            )
        )
    })

    scribe.put("/:component/:id", (req, res, next) => {
        deliver(res, core.updateRecord(req.params.component, req.params.component, req.params.id, req.body))
    })

    scribe.delete("/:component/:subcomponent/all", (req, res, next) => {
        // delete id if it exists
        // fail if it doesn't exist
        deliver(res, core.deleteAllRecords(`${req.params.component}_${req.params.subcomponent}`))
    })

    scribe.delete("/:component/all", (req, res, next) => {
        // delete id if it exists
        // fail if it doesn't exist
        deliver(res, core.deleteAllRecords(req.params.component))
    })

    scribe.delete("/:component/:subcomponent/:id", (req, res, next) => {
        // delete id if it exists
        // fail if it doesn't exist
        deliver(res, core.deleteRecord(`${req.params.component}_${req.params.subcomponent}`, req.params.id))
    })

    scribe.delete("/:component/:id", (req, res, next) => {
        // allow :subcomponent route to fall through
        if (Number.isNaN(Number.parseInt(req.params.id))) {
            next()
            return
        }

        // fail if it doesn't exist
        deliver(res, core.deleteRecord(req.params.component, req.params.id))
    })

    scribe.delete("/:component/:subcomponent", (req, res, next) => {
        // delete table if it exists
        deliver(res, core.dropComponent(`${req.params.component}_${req.params.subcomponent}`))
        // send response success or fail
    })

    scribe.delete("/:component", (req, res, next) => {
        // delete table if it exists
        deliver(res, core.dropComponent(req.params.component))

        if (req.query.recursive) {
            // TODO find and delete all subcomponents
        }

        // send response success or fail
    })

    scribe.get("/", (req, res, next) => {
        res.statusCode = 200
        res.send()
    })

    scribe.all("*", (req, res, next) => {
        res.status(400).send("Unhandled Route")
    })

    const scribeServer = scribe.listen(argv.port, () => {
        console.log(
            "Scribe - Process: %sd, Name: %s, Home: %s, Port: %d, Mode: %s, DB Name: %s",
            process.pid,
            argv.name,
            argv.home,
            argv.port,
            argv.mode,
            argv.dbName
        )
    })

    scribeServer.on("close", () => {
        core.close()
    })

    return scribeServer
}
