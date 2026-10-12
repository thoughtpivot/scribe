/** Bun transport only. `GET /healthz` is not an Express route. Shared CRUD lives in `src/routes.test.ts`. */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { DateTime } from "luxon"

process.env.SCRIBE_APP_DB_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_DB_PORT ??= "5432"
process.env.SCRIBE_APP_DB_USER ??= "postgres"
process.env.SCRIBE_APP_DB_PASS ??= "postgres"
process.env.SCRIBE_APP_DB_NAME ??= "scribe_bun_test"
process.env.SCRIBE_APP_REDIS_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_REDIS_PORT ??= "6379"

const created = DateTime.utc().minus({ days: 1 }).toISO()
const modified = DateTime.utc().toISO()
const record = {
    data: {
        something: "somethingstring",
        ids: [1, 3, 5]
    },
    date_created: created,
    date_modified: modified,
    created_by: 2,
    modified_by: 2
}

let url = ""
let stop: ((closeActiveConnections?: boolean) => Promise<void>) | undefined

beforeAll(async () => {
    const { tryCreateDb } = await import("../core.js")
    const { openScribe } = await import("./server.js")
    await tryCreateDb()
    const server = await openScribe(undefined, { port: 0, hostname: "127.0.0.1" })
    stop = (close) => server.stop(close)
    url = `http://127.0.0.1:${server.port}`
    const dropped = await fetch(`${url}/bunsmoke`, { method: "DELETE" })
    expect(dropped.status).toBe(200)
})

afterAll(async () => {
    await stop?.(true)
})

test("GET /healthz is healthy when Postgres and Redis are up", async () => {
    const health = await fetch(`${url}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: "healthy", db: "up", redis: "up" })
})

test("core routes create, read, query, and reject unknown paths", async () => {
    const root = await fetch(`${url}/`)
    expect(root.status).toBe(200)
    expect(await root.text()).toBe("")

    const post = await fetch(`${url}/bunsmoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record)
    })
    expect(post.status).toBe(200)
    const createdRows = await post.json()
    expect(createdRows[0].id).toBe(1)
    expect(createdRows[0].data).toEqual(record.data)
    expect(createdRows[0].created_by).toBe(2)

    const all = await fetch(`${url}/bunsmoke/all`)
    expect(all.status).toBe(200)
    expect(await all.json()).toEqual(createdRows)

    const filtered = await fetch(`${url}/bunsmoke/all?filter[created_by][0]=2`)
    expect(filtered.status).toBe(200)
    expect(await filtered.json()).toEqual(createdRows)

    const one = await fetch(`${url}/bunsmoke/1`)
    expect(one.status).toBe(200)
    expect(await one.json()).toEqual(createdRows)

    const sql = await fetch(`${url}/sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "SELECT 1 AS ok" })
    })
    expect(sql.status).toBe(200)
    expect(await sql.json()).toEqual([{ ok: 1 }])

    const missing = await fetch(`${url}/sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
    })
    expect(missing.status).toBe(400)
    expect(await missing.text()).toBe("Missing query property.")

    const unknown = await fetch(`${url}/nope/not/a/route`)
    expect(unknown.status).toBe(400)
    expect(await unknown.text()).toBe("Unhandled Route")

    const removed = await fetch(`${url}/bunsmoke/1`, { method: "DELETE" })
    expect(removed.status).toBe(200)
    const afterDelete = await fetch(`${url}/bunsmoke/all`)
    expect(await afterDelete.json()).toEqual([])
})
