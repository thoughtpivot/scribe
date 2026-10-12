/**
 * Shared route suite for both Scribe servers.
 *
 * `npm test` runs the compiled file on Node against the Express `scribe` server.
 * `npm run test:bun` runs this source on Bun against `scribe-bun`.
 * Cases here are transport-agnostic (core CRUD, filters, schema reload, and `SCRIBE_APP` options).
 * Bun-only coverage stays in `src/bun`: `GET /healthz` and dependency probes.
 * GET requests that carry a JSON body are Express-only. `Bun.serve` does not expose that body.
 */
import { DateTime } from "luxon"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import http, { type Server } from "node:http"
import { dirname, join } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

process.env.SCRIBE_APP_DB_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_DB_PORT ??= "5432"
process.env.SCRIBE_APP_DB_USER ??= "postgres"
process.env.SCRIBE_APP_DB_PASS ??= "postgres"
process.env.SCRIBE_APP_DB_NAME ??= "scribe_routes_test"
process.env.SCRIBE_APP_REDIS_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_REDIS_PORT ??= "6379"
process.env.SCRIBE_APP_PORT ??= "0"

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "default.table.schema.json")
const created = DateTime.utc().minus({ days: 1 }).toISO()
const modified = DateTime.utc().toISO()
const transport = runningOnBun() ? "scribe-bun" : "scribe"
const expressOnlyGetBody = runningOnBun() ? "Express only: Bun.serve does not expose a GET body" : false
const original = {
    data: {
        something: "somethingstring",
        ids: [1, 3, 5]
    },
    date_created: created,
    date_modified: modified,
    created_by: 2,
    modified_by: 2
}

let endpoint = ""
let stop: (() => Promise<void>) | undefined

interface TableSchema {
    required: string[]
    properties: Record<string, { type: string }>
}

interface Started {
    url: string
    close: () => Promise<void>
}

/**
 *
 * @param data
 * @param extra
 */
function row(data: Record<string, unknown>, extra: Record<string, unknown> = {}): Array<Record<string, unknown>> {
    return [
        {
            id: 1,
            data,
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2,
            ...extra
        }
    ]
}

/**
 *
 */
function runningOnBun(): boolean {
    return "Bun" in globalThis
}

/**
 *
 * @param schema
 */
async function start(schema?: TableSchema): Promise<Started> {
    if (runningOnBun()) {
        const specifier = "./bun/server.js"
        const { openScribe } = (await import(specifier)) as {
            openScribe: (
                schemaOverride?: TableSchema,
                listen?: { port?: number; hostname?: string }
            ) => Promise<{ port: number; stop: (closeActiveConnections?: boolean) => Promise<void> }>
        }

        const server = await openScribe(schema, { port: 0, hostname: "127.0.0.1" })

        return {
            url: `http://127.0.0.1:${server.port}`,
            close: () => server.stop(true)
        }
    }

    const { createServer } = await import("./scribe.js")
    const server = await createServer(schema)
    await waitUntilListening(server)
    const address = server.address()

    if (address === null || typeof address === "string") throw new Error("scribe did not bind a TCP port")

    const host = address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address

    return {
        url: `http://${host}:${address.port}`,
        close: () =>
            new Promise((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()))
            })
    }
}

/**
 *
 * @param server
 */
function waitUntilListening(server: Server): Promise<void> {
    if (server.listening) return Promise.resolve()

    return new Promise((resolve) => {
        server.once("listening", () => resolve())
    })
}

/**
 *
 * @param schema
 */
async function boot(schema?: TableSchema): Promise<void> {
    if (stop) {
        await stop()
        stop = undefined
    }

    const started = await start(schema)
    endpoint = started.url
    stop = started.close
}

/**
 *
 * @param text
 */
function parseBody(text: string): unknown {
    if (text.length === 0) return text

    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

/**
 *
 * @param method
 * @param path
 * @param body
 */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    // Node and Bun fetch both reject a GET body. The suite still sends one, matching the old chai-http cases.
    if (body !== undefined && method === "GET") return callGetWithBody(path, body)

    const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    })

    const text = await response.text()

    return { status: response.status, json: parseBody(text) }
}

/**
 *
 * @param path
 * @param body
 */
function callGetWithBody(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const payload = JSON.stringify(body)
    const url = new URL(path, endpoint)

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                headers: {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload)
                }
            },
            (response) => {
                const chunks: Buffer[] = []
                response.on("data", (chunk: Buffer) => chunks.push(chunk))
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8")
                    resolve({ status: response.statusCode ?? 0, json: parseBody(text) })
                })
            }
        )

        req.on("error", reject)
        req.end(payload)
    })
}

describe(`Scribe routes (${transport})`, { concurrency: false }, () => {
    before(async () => {
        const { tryCreateDb } = await import("./core.js")
        await tryCreateDb()
        await boot()
    })

    after(async () => {
        await stop?.()
        stop = undefined
    })

    it("reads SCRIBE_APP database and Redis options", async () => {
        const { argv } = await import("./core.js")
        assert.equal(argv.dbHost, process.env.SCRIBE_APP_DB_HOST)
        assert.equal(Number(argv.dbPort), Number(process.env.SCRIBE_APP_DB_PORT))
        assert.equal(argv.dbUser, process.env.SCRIBE_APP_DB_USER)
        assert.equal(argv.dbName, process.env.SCRIBE_APP_DB_NAME)
        assert.equal(argv.redisHost, process.env.SCRIBE_APP_REDIS_HOST)
        assert.equal(Number(argv.redisPort), Number(process.env.SCRIBE_APP_REDIS_PORT))
    })

    it("Checks that server is running", async () => {
        const res = await call("GET", "/")
        assert.equal(res.status, 200)
    })

    it("DEL component table", async () => {
        const res = await call("DELETE", "/testComponent")
        assert.equal(res.status, 200)
        assert.deepStrictEqual(res.json, [])
    })

    it("DEL subcomponent table", async () => {
        const res = await call("DELETE", "/testComponent/sub")
        assert.equal(res.status, 200)
        assert.deepStrictEqual(res.json, [])
    })

    it("POST to component", async () => {
        const res = await call("POST", "/testComponent", original)
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries", async () => {
        const res = await call("GET", "/testComponent/all")
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries with query filter", async () => {
        const res = await call("GET", "/testComponent/all?filter[created_by][0]=2")
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries with query filter2 is one of", async () => {
        const res = await call("GET", "/testComponent/all?filter2[id][0]=is%20one%20of&filter2[id][1][0]=1")
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries with query filter2 is one of nested", async () => {
        const res = await call("GET", "/testComponent/all?filter2[data.something][0]=is%20one%20of&filter2[data.something][1]=somethingstring")
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries with query filter2 contains", async () => {
        const res = await call("GET", "/testComponent/all?filter2[data.ids][0]=contains&filter2[data.ids][1][0]=3")
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries with query filter expect none", { skip: expressOnlyGetBody }, async () => {
        const res = await call("GET", "/testComponent/all", { filter: { created_by: [3] } })
        assert.deepStrictEqual(res.json, [])
    })

    it("GET all entries with body filter", { skip: expressOnlyGetBody }, async () => {
        const res = await call("GET", "/testComponent/all", { filter: { created_by: [2] } })
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries with body filter nested", { skip: expressOnlyGetBody }, async () => {
        const res = await call("GET", "/testComponent/all", { filter: { "data.something": "somethingstring" } })
        assert.deepStrictEqual(res.json, row(original.data))
    })

    it("GET all entries with body filter expect none", async () => {
        const res = await call("GET", "/testComponent/all?filter[created_by][0]=3")
        assert.deepStrictEqual(res.json, [])
    })

    it("GET from table that doesn't exist should return empty array", async () => {
        const res = await call("GET", "/someTableThatDoesntExist/all")
        assert.deepStrictEqual(res.json, [])
    })

    it("PUT entry", async () => {
        const data = {
            something: "we changed this",
            ids: [1, 3, 5],
            data2: "new thing"
        }

        const res = await call("PUT", "/testComponent/1", {
            data,
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2
        })

        assert.deepStrictEqual(res.json, row(data))
    })

    it("PUT with schema change", async () => {
        const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as TableSchema
        schema.required.push("new_column")
        schema.properties.new_column = { type: "string" }
        await boot(schema)

        const res = await call("PUT", "/testComponent/1", {
            data: original.data,
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2,
            new_column: "woot"
        })

        assert.deepStrictEqual(res.json, row(original.data, { new_column: '"woot"' }))
    })
})
