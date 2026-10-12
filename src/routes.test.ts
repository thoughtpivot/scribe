/**
 * Shared route suite for both Scribe servers.
 *
 * `npm test` runs the compiled file on Node against the Express `scribe` server.
 * `npm run test:bun` runs this source on Bun against `scribe-bun`.
 * Cases here are transport-agnostic (core CRUD, filters, schema reload, schema discovery, and `SCRIBE_APP` options).
 * Bun-only coverage stays in `src/bun`: `GET /healthz` and dependency probes.
 * GET requests that carry a JSON body are Express-only. `Bun.serve` does not expose that body.
 */
import { DateTime } from "luxon"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http, { type Server } from "node:http"
import { tmpdir } from "node:os"
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

    describe("discovered component schemas", () => {
        const saved: {
            appHome: unknown
            excludePaths: unknown
            schemaBaseUrl: unknown
            requireSchema: unknown
        } = {
            appHome: undefined,
            excludePaths: undefined,
            schemaBaseUrl: undefined,
            requireSchema: undefined
        }

        let appHome = ""
        let remote: Server | undefined
        let hits: string[] = []

        before(async () => {
            const { argv } = await import("./core.js")

            saved.appHome = argv.app_home
            saved.excludePaths = argv.exclude_paths
            saved.schemaBaseUrl = argv.schemaBaseUrl
            saved.requireSchema = argv.requireSchema
            appHome = mkdtempSync(join(tmpdir(), "scribe-app-"))
            writeSchema(appHome, "components/Widget/Widget.schema.json", {
                type: "object",
                additionalProperties: false,
                required: ["data", "nickname"],
                properties: {
                    data: { type: "object" },
                    nickname: { type: "string" }
                }
            })
            writeSchema(appHome, "components/Widget/Part/Part.schema.json", {
                type: "object",
                additionalProperties: false,
                required: ["data", "sku"],
                properties: {
                    data: { type: "object" },
                    sku: { type: "string" }
                }
            })
            writeSchema(appHome, "components/Hidden/Hidden.schema.json", {
                type: "object",
                additionalProperties: false,
                required: ["secret"],
                properties: {
                    secret: { type: "string" }
                }
            })
            hits = []
            const fallbackSchema = readFileSync(schemaPath, "utf8")

            remote = http.createServer((req, res) => {
                hits.push(req.url ?? "")
                res.writeHead(200, { "content-type": "application/json" })
                res.end(fallbackSchema)
            })
            const port = await listen(remote)

            argv.app_home = appHome
            argv.exclude_paths = ["components/Hidden"]
            argv.schemaBaseUrl = `http://127.0.0.1:${port}`
            argv.requireSchema = false
            await boot()
        })

        after(async () => {
            const { argv } = await import("./core.js")

            argv.app_home = saved.appHome as typeof argv.app_home
            argv.exclude_paths = saved.excludePaths as typeof argv.exclude_paths
            argv.schemaBaseUrl = saved.schemaBaseUrl as typeof argv.schemaBaseUrl
            argv.requireSchema = saved.requireSchema as typeof argv.requireSchema

            if (remote) {
                const closing = remote

                remote = undefined
                await new Promise<void>((resolve, reject) => {
                    closing.close((err) => (err ? reject(err) : resolve()))
                })
            }

            if (appHome) rmSync(appHome, { recursive: true, force: true })
        })

        it("uses a discovered schema instead of schemaBaseUrl", async () => {
            const rejected = await call("POST", "/Widget", { data: { a: 1 } })

            assert.equal(rejected.status, 400)
            assert.match(JSON.stringify(rejected.json), /nickname/)

            const createdRow = await call("POST", "/Widget", { data: { a: 1 }, nickname: "Ada" })

            assert.equal(createdRow.status, 200)
            const body = createdRow.json as Array<{ nickname: string; data: { a: number } }>

            assert.equal(body[0].nickname, '"Ada"')
            assert.deepStrictEqual(body[0].data, { a: 1 })
            assert.deepStrictEqual(hits, [])
        })

        it("uses a discovered subcomponent schema", async () => {
            const rejected = await call("POST", "/Widget/Part", { data: { a: 1 } })

            assert.equal(rejected.status, 400)
            assert.match(JSON.stringify(rejected.json), /sku/)

            const createdRow = await call("POST", "/Widget/Part", { data: { a: 1 }, sku: "A-1" })

            assert.equal(createdRow.status, 200)
            const body = createdRow.json as Array<{ sku: string }>

            assert.equal(body[0].sku, '"A-1"')
            assert.deepStrictEqual(hits, [])
        })

        it("falls back to schemaBaseUrl when the schema file is excluded", async () => {
            const res = await call("POST", "/Hidden", original)
            const body = res.json as Array<Record<string, unknown>>

            assert.equal(res.status, 200)
            assert.equal(body.length, 1)
            assert.deepStrictEqual(body[0].data, original.data)
            assert.equal(body[0].created_by, 2)
            assert.equal(body[0].modified_by, 2)
            assert.equal(hits.length, 1)
            assert.match(hits[0], /\/Hidden\/schema$/)
        })
    })
})

/**
 * @param root
 * @param rel
 * @param schema
 */
function writeSchema(root: string, rel: string, schema: object): void {
    const abs = join(root, rel)

    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(schema))
}

/**
 * @param server
 */
function listen(server: Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            const address = server.address()

            if (address === null || typeof address === "string") {
                reject(new Error("schema server did not bind"))
                return
            }

            resolve(address.port)
        })
    })
}
