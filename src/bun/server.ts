#!/usr/bin/env bun
/**
 * Bun transport for Scribe. One process, no cluster.
 * Node (`scribe`) and Bun (`scribe-bun`) install notes live in THO-244.
 */
import { STATUS_CODES } from "node:http"

import qs from "qs"

import { argv, createCore, rejectSqlBody, tryCreateDb, type CoreResponse, type ScribeCore } from "../core.js"

const HTML = "text/html; charset=utf-8"
const TEXT = "text/plain; charset=utf-8"
const JSON_TYPE = "application/json; charset=utf-8"

interface ScribeRequest extends Request {
    params: Record<string, string>
}

/** Listening Bun server. `stop` closes sockets and the core's Postgres and Redis clients. */
export interface ScribeBunServer {
    port: number
    stop(closeActiveConnections?: boolean): Promise<void>
}

/**
 * @param limit
 */
function payloadLimitBytes(limit: unknown): number {
    if (typeof limit === "number" && Number.isFinite(limit)) return limit

    const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(String(limit).trim())
    if (!match) return 50 * 1024 * 1024

    const amount = Number(match[1])
    const unit = (match[2] ?? "b").toLowerCase()
    const scale = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1
    return Math.floor(amount * scale)
}

/**
 * @param status
 * @param body
 */
function html(status: number, body: string): Response {
    return new Response(body, { status, headers: { "content-type": HTML } })
}

/**
 * Express `res.send` / `res.sendStatus`, including the content type each one sets.
 *
 * @param result
 */
function toResponse(result: CoreResponse): Response {
    let status = 200
    let sent = false
    let response = new Response(null, { status: 200 })

    const send = (body: unknown, contentType?: string) => {
        if (body === undefined || body === null) {
            response = new Response(null, { status })
            return
        }

        if (typeof body === "string") {
            response = new Response(body, { status, headers: { "content-type": contentType ?? HTML } })
            return
        }

        response = new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_TYPE } })
    }

    for (const effect of result.effects) {
        if (effect.op === "status") status = effect.code
        else if (effect.op === "send") {
            sent = true
            send(effect.body)
        } else {
            sent = true
            status = effect.code
            send(STATUS_CODES[effect.code] ?? String(effect.code), TEXT)
        }
    }

    if (result.sendValue && !sent) send(result.value)

    return response
}

/**
 * @param req
 */
function queryOf(req: Request): any {
    const raw = new URL(req.url).search
    const value = raw.startsWith("?") ? raw.slice(1) : raw
    return qs.parse(value, { allowPrototypes: true, arrayLimit: 1000 })
}

/**
 * @param req
 */
async function readBody(req: Request): Promise<{ body: any } | { error: Response }> {
    const header = req.headers.get("content-type") ?? ""
    if (!/^application\/(?:json|.+\+json)(?:\s*;|$)/i.test(header)) return { body: {} }

    const limit = payloadLimitBytes(argv.payloadLimit)
    const declared = Number(req.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > limit) return { error: html(413, "Payload Too Large") }

    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.byteLength > limit) return { error: html(413, "Payload Too Large") }
    if (bytes.byteLength === 0) return { body: {} }

    try {
        return { body: JSON.parse(new TextDecoder().decode(bytes)) }
    } catch (err) {
        console.error(err)
        return { error: html(400, "Bad Request") }
    }
}

/**
 * @param req
 * @param name
 */
function param(req: ScribeRequest, name: string): string {
    const value = req.params[name]
    if (!value) throw new Error(`Missing route param ${name}`)

    return value
}

/**
 * Express falls through `DELETE /:component/:id` when the second segment is not an integer
 * so `DELETE /:component/:subcomponent` can drop that table. Bun has one pattern for both.
 *
 * @param id
 */
function isRecordId(id: string): boolean {
    return !Number.isNaN(Number.parseInt(id))
}

/**
 * @param req
 * @param run
 */
async function handle(req: ScribeRequest, run: (body: any, query: any) => CoreResponse | Promise<CoreResponse>): Promise<Response> {
    try {
        const loaded = await readBody(req)
        if ("error" in loaded) return loaded.error

        return toResponse(await run(loaded.body ?? {}, queryOf(req)))
    } catch (err) {
        console.error(err)
        return html(500, "Internal Server Error")
    }
}

/**
 * Same routes as the Express transport, plus `GET /healthz`.
 *
 * @param core
 */
function createRoutes(core: ScribeCore): Record<string, Record<string, (req: ScribeRequest) => Promise<Response> | Response>> {
    return {
        "/healthz": {
            GET: async () => {
                const health = await core.health()
                const healthy = health.db && health.redis
                return Response.json(
                    {
                        status: healthy ? "healthy" : "unhealthy",
                        db: health.db ? "up" : "down",
                        redis: health.redis ? "up" : "down"
                    },
                    { status: healthy ? 200 : 503 }
                )
            }
        },
        "/sql": {
            POST: (req) =>
                handle(req, (body) => {
                    const rejected = rejectSqlBody(body)
                    if (rejected) return rejected

                    return core.runSql(body.query)
                })
        },
        "/": {
            GET: () => new Response(null, { status: 200 })
        },
        "/:component/all": {
            POST: (req) => handle(req, (body, query) => core.readAll(param(req, "component"), query, body)),
            GET: (req) => handle(req, (body, query) => core.readAll(param(req, "component"), query, body)),
            DELETE: (req) => handle(req, () => core.deleteAllRecords(param(req, "component")))
        },
        "/:component/:subcomponent/all": {
            POST: (req) => handle(req, (body, query) => core.readAll(`${param(req, "component")}_${param(req, "subcomponent")}`, query, body)),
            GET: (req) => handle(req, (body, query) => core.readAll(`${param(req, "component")}_${param(req, "subcomponent")}`, query, body)),
            DELETE: (req) => handle(req, () => core.deleteAllRecords(`${param(req, "component")}_${param(req, "subcomponent")}`))
        },
        "/:component/:id/history": {
            GET: (req) => handle(req, () => core.readHistory(param(req, "component"), param(req, "id")))
        },
        "/:component/:subcomponent/:id/history": {
            GET: (req) => handle(req, () => core.readHistory(`${param(req, "component")}_${param(req, "subcomponent")}`, param(req, "id")))
        },
        "/:component/:subcomponent/:id": {
            GET: (req) =>
                handle(req, (body, query) => core.readOne(`${param(req, "component")}_${param(req, "subcomponent")}`, param(req, "id"), query, body)),
            PUT: (req) =>
                handle(req, (body) =>
                    core.updateRecord(
                        `${param(req, "component")}_${param(req, "subcomponent")}`,
                        `${param(req, "component")}/${param(req, "subcomponent")}`,
                        param(req, "id"),
                        body
                    )
                ),
            DELETE: (req) => handle(req, () => core.deleteRecord(`${param(req, "component")}_${param(req, "subcomponent")}`, param(req, "id")))
        },
        "/:component/:id": {
            GET: (req) => handle(req, (body, query) => core.readOne(param(req, "component"), param(req, "id"), query, body || {})),
            PUT: (req) => handle(req, (body) => core.updateRecord(param(req, "component"), param(req, "component"), param(req, "id"), body)),
            POST: (req) =>
                handle(req, (body) =>
                    core.createRecord(`${param(req, "component")}_${param(req, "id")}`, `${param(req, "component")}/${param(req, "id")}`, body)
                ),
            DELETE: (req) =>
                handle(req, () => {
                    const component = param(req, "component")
                    const id = param(req, "id")
                    if (!isRecordId(id)) return core.dropComponent(`${component}_${id}`)

                    return core.deleteRecord(component, id)
                })
        },
        "/:component": {
            POST: (req) => handle(req, (body) => core.createRecord(param(req, "component"), param(req, "component"), body)),
            DELETE: (req) => handle(req, () => core.dropComponent(param(req, "component")))
        }
    }
}

/**
 * Listen with Bun. Pass `port: 0` for an ephemeral port.
 *
 * @param schemaOverride
 * @param listen
 */
export async function openScribe(schemaOverride: any = undefined, listen: { port?: number; hostname?: string } = {}): Promise<ScribeBunServer> {
    const core = await createCore(schemaOverride)
    const server = Bun.serve({
        port: listen.port ?? Number(argv.port),
        hostname: listen.hostname,
        routes: createRoutes(core),
        fetch() {
            return html(400, "Unhandled Route")
        },
        error(err) {
            console.error(err)
            return html(500, "Internal Server Error")
        }
    })

    console.log(
        "scribe-bun - Process: %d, Name: %s, Home: %s, Port: %d, Mode: %s, DB Name: %s",
        process.pid,
        argv.name,
        argv.home,
        server.port,
        argv.mode,
        argv.dbName
    )

    return {
        port: server.port,
        async stop(closeActiveConnections = false) {
            await server.stop(closeActiveConnections)
            await core.close()
        }
    }
}

if (import.meta.main) {
    const command = process.argv[2]

    if (command === "generate" || command === "run") {
        const { migrationCommand } = await import("../migrations.cli.js")

        try {
            await migrationCommand(process.argv.slice(2))
        } catch (error: unknown) {
            console.error(error instanceof Error ? error.message : error)
            process.exitCode = 1
        }
    } else {
        await tryCreateDb()
        await openScribe()
    }
}
