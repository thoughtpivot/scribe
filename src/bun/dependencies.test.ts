import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SCRIBE_APP_DB_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_DB_PORT ??= "5432"
process.env.SCRIBE_APP_DB_USER ??= "postgres"
process.env.SCRIBE_APP_DB_PASS ??= "postgres"
process.env.SCRIBE_APP_DB_NAME ??= "scribe_bun_test"
process.env.SCRIBE_APP_REDIS_HOST ??= "127.0.0.1"
process.env.SCRIBE_APP_REDIS_PORT ??= "6379"
process.env.AWS_EC2_METADATA_DISABLED ??= "true"

const host = process.env.SCRIBE_APP_DB_HOST
const port = Number(process.env.SCRIBE_APP_DB_PORT)
const user = process.env.SCRIBE_APP_DB_USER
const password = process.env.SCRIBE_APP_DB_PASS
const probeDb = `scribe_bun_deps_${Date.now()}`
const admin = { host, port, user, password }

afterAll(async () => {
    const pgtools = (await import("pgtools")).default
    try {
        await pgtools.dropdb(admin, probeDb)
    } catch (err) {
        if ((err as { name?: string }).name !== "invalid_catalog_name") throw err
    }
})

test("pgtools creates a database and pg-promise runs CRUD", async () => {
    const pgtools = (await import("pgtools")).default
    const created = await pgtools.createdb(admin, probeDb)
    expect(created.command).toBe("CREATE")

    try {
        await pgtools.createdb(admin, probeDb)
        throw new Error("expected duplicate_database")
    } catch (err) {
        expect((err as { name?: string }).name).toBe("duplicate_database")
    }

    const iamDb = `${probeDb}_iam`
    const iamConfig = { ...admin, password: async () => password }
    await pgtools.createdb(iamConfig, iamDb)
    await pgtools.dropdb(iamConfig, iamDb)

    const pgPromise = (await import("pg-promise")).default
    const db = pgPromise()({ ...admin, database: probeDb })
    try {
        await db.none("CREATE TABLE probe(id serial PRIMARY KEY, note text)")
        const inserted = await db.one("INSERT INTO probe(note) VALUES ($1) RETURNING id, note", ["hello"])
        expect(inserted.note).toBe("hello")
        const updated = await db.one("UPDATE probe SET note = $1 WHERE id = $2 RETURNING note", ["there", inserted.id])
        expect(updated.note).toBe("there")
        expect(await db.any("SELECT note FROM probe")).toEqual([{ note: "there" }])
        await db.none("DELETE FROM probe WHERE id = $1", [inserted.id])
        expect(await db.any("SELECT id FROM probe")).toEqual([])
    } finally {
        await db.$pool.end()
    }
})

test("tryCreateDb is idempotent against Postgres", async () => {
    const { tryCreateDb } = await import("../core.js")
    await tryCreateDb()
    await tryCreateDb()
})

test("redis client reads and writes", async () => {
    const { createClient } = await import("redis")
    const client = createClient({
        url: `redis://${process.env.SCRIBE_APP_REDIS_HOST}:${process.env.SCRIBE_APP_REDIS_PORT}/1`
    })
    client.on("error", () => undefined)
    await client.connect()
    const key = `scribe:bun:deps:${Date.now()}`
    try {
        await client.set(key, "pong")
        expect(await client.get(key)).toBe("pong")
        await client.del(key)
    } finally {
        await client.quit()
    }
})

test("@aws-sdk/rds-signer builds an auth token offline", async () => {
    const { Signer } = await import("@aws-sdk/rds-signer")
    const signer = new Signer({
        hostname: "scribe.example.rds.amazonaws.com",
        port: 5432,
        username: "scribe",
        region: "us-east-1",
        credentials: {
            accessKeyId: "AKIAIOSFODNN7EXAMPLE",
            secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        }
    })
    const token = await signer.getAuthToken()
    expect(token).toContain("scribe.example.rds.amazonaws.com")
    expect(token).toContain("X-Amz-Algorithm=")
    expect(token).toContain("X-Amz-Signature=")
})

test("express-bunyan-logger records a request", async () => {
    const express = (await import("express")).default
    const loggerFactory = (await import("express-bunyan-logger")).default
    const dir = mkdtempSync(join(tmpdir(), "scribe-bunyan-"))
    const logPath = join(dir, "scribe.json")
    const lines: string[] = []
    const app = express()
    app.use(
        loggerFactory({
            name: "scribe-bun",
            streams: [
                {
                    level: "info",
                    stream: {
                        write(chunk: string) {
                            lines.push(String(chunk))
                        }
                    }
                },
                {
                    level: "info",
                    type: "rotating-file",
                    path: logPath,
                    period: "1d",
                    count: 3
                }
            ]
        })
    )
    app.get("/ping", (_req, res) => {
        res.status(200).send("ok")
    })

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")

    const res = await fetch(`http://127.0.0.1:${address.port}/ping`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
    })

    expect(lines.join("")).toContain("/ping")
    expect(readFileSync(logPath, "utf8")).toContain("/ping")
})

test("ajv compiles schemas", async () => {
    const Ajv = (await import("ajv")).default
    const ajv = new Ajv({
        loadSchema: async () => ({ type: "string" })
    })
    const schema = {
        type: "object",
        properties: { something: { type: "string" } },
        required: ["something"]
    }
    const validate = ajv.compile(schema)
    expect(validate({ something: "x" })).toBe(true)
    expect(validate({})).toBe(false)
    const asyncValidate = await ajv.compileAsync(schema)
    expect(asyncValidate({ something: "y" })).toBe(true)
    expect(asyncValidate({})).toBe(false)
})

test("luxon parses timestamps", async () => {
    const { DateTime } = await import("luxon")
    const now = DateTime.utc()
    const earlier = now.minus({ days: 1 })
    expect(earlier < now).toBe(true)
    const parsed = DateTime.fromISO(now.toISO() ?? "")
    expect(parsed.isValid).toBe(true)
    expect(parsed.toUTC().toISO()).toBe(now.toISO())
})

test("diff-match-patch round-trips a record patch", async () => {
    const { diff_match_patch } = await import("diff-match-patch")
    const dmp = new diff_match_patch()
    const before = JSON.stringify({ id: 1, data: { something: "a" } })
    const after = JSON.stringify({ id: 1, data: { something: "b" } })
    const text = dmp.patch_toText(dmp.patch_make(before, after))
    const [patched] = dmp.patch_apply(dmp.patch_fromText(text), before)
    expect(patched).toBe(after)
})

test("yargs reads flags and the SCRIBE_APP env prefix", async () => {
    const yargs = (await import("yargs")).default
    const { hideBin } = await import("yargs/helpers")
    const parsed = yargs(hideBin(["bun", "scribe", "--dbName", "from-flag"]))
        .env("SCRIBE_APP")
        .option("dbName", { default: "scribe" })
        .option("dbHost", { default: "localhost" })
        .parseSync()
    expect(parsed.dbName).toBe("from-flag")

    const { argv } = await import("../core.js")
    expect(argv.dbHost).toBe(host)
    expect(Number(argv.dbPort)).toBe(port)
    expect(argv.redisHost).toBe(process.env.SCRIBE_APP_REDIS_HOST)
})
