import { assert, expect, use } from "chai"
import chaiHttp from "chai-http"
import type { Server } from "http"
import { DateTime } from "luxon"
import { createRequire } from "module"
import type { AddressInfo } from "net"

import { createServer, tryCreateDb } from "./scribe.js"

/** Chai 6: `use()` returns the augmented instance (including `request` from chai-http). */
const chai = use(chaiHttp) as Chai.ChaiStatic

/**
 * chai-http v5 sets `chai.request` to the request module namespace; URL/app entrypoint is `.execute`.
 * @param url
 */
const serve = (url: string) => (chai.request as unknown as { execute: (app: string) => ChaiHttp.Agent }).execute(url)

let server: Server | undefined

/**
 *
 */
function baseUrl(): string {
    if (!server) throw new Error("Server not started")

    const addr = server.address()
    if (addr === null || typeof addr === "string") throw new Error("Unexpected server address")

    const { port } = addr as AddressInfo
    return `http://127.0.0.1:${port}`
}

/**
 * Drops keep-alive sockets so a replacement server can bind before the next request (see PUT with schema change).
 * @param s
 */
function stopHttpServer(s: Server): Promise<void> {
    return new Promise((resolve) => {
        if (!s.listening) {
            resolve()
            return
        }

        s.closeAllConnections()
        s.close(() => resolve())
    })
}

const require = createRequire(import.meta.url)
const schema = require("./default.table.schema.json")
const now = DateTime.utc()
const created = now.minus({ days: 1 }).toISO()
const modified = now.toISO()

before(function (done: any) {
    tryCreateDb()
        .then(() => {
            createServer(schema)
                .then((scribeServer) => {
                    server = scribeServer
                    done()
                })
                .catch((error) => {
                    done(error)
                })
        })
        .catch((error) => {
            done(error)
        })
})

after(function (done: any) {
    if (!server) {
        done()
        return
    }

    stopHttpServer(server).then(() => done())
})

describe("Scribe", function () {
    it("Checks that server is running", function (done: any) {
        serve(baseUrl())
            .get("/")
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.equal(res.status, 200)
                done()
            })
    })

    it("DEL component table", function (done: any) {
        serve(baseUrl())
            .del("/testComponent")
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.equal(res.status, 200)
                expect(res.body).to.eql([])
                done()
            })
    })

    it("DEL subcomponent table", function (done: any) {
        serve(baseUrl())
            .del("/testComponent/sub")
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.equal(res.status, 200)
                expect(res.body).to.eql([])
                done()
            })
    })

    it("POST to component", function (done: any) {
        const request = {
            data: {
                something: "somethingstring",
                ids: [1, 3, 5]
            },
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2
        }

        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .post("/testComponent")
            .send(request)
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries", function (done: any) {
        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .get("/testComponent/all")
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with query filter", function (done: any) {
        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .get("/testComponent/all")
            .query({ filter: { created_by: [2] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with query filter2 is one of", function (done: any) {
        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .get("/testComponent/all")
            .query({ filter2: { id: ["is one of", [1]] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with query filter2 is one of nested", function (done: any) {
        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .get("/testComponent/all")
            .query({ filter2: { "data.something": ["is one of", "somethingstring"] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with query filter2 contains", function (done: any) {
        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .get("/testComponent/all")
            .query({ filter2: { "data.ids": ["contains", [3]] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with query filter expect none", function (done: any) {
        const expectedResponse: any[] = []
        serve(baseUrl())
            .post("/testComponent/all")
            .send({ filter: { created_by: [3] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with body filter", function (done: any) {
        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .post("/testComponent/all")
            .send({ filter: { created_by: [2] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with body filter nested", function (done: any) {
        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .post("/testComponent/all")
            .send({ filter: { "data.something": "somethingstring" } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with body filter expect none", function (done: any) {
        const expectedResponse: any[] = []
        serve(baseUrl())
            .post("/testComponent/all")
            .send({ filter: { created_by: [3] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET from table that doesn't exist should return empty array", function (done: any) {
        const expectedResponse: any[] = []
        serve(baseUrl())
            .get("/someTableThatDoesntExist/all")
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("PUT entry", function (done: any) {
        const request = {
            data: {
                something: "we changed this",
                ids: [1, 3, 5],
                data2: "new thing"
            },
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2
        }

        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "we changed this",
                    ids: [1, 3, 5],
                    data2: "new thing"
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        serve(baseUrl())
            .put("/testComponent/1")
            .send(request)
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("PUT with schema change", async function () {
        if (server) await stopHttpServer(server)

        const newSchema = JSON.parse(JSON.stringify(schema)) as typeof schema
        newSchema.required.push("new_column")
        newSchema.properties.new_column = {
            type: "string"
        }

        server = await createServer(newSchema)

        const request = {
            data: {
                something: "somethingstring",
                ids: [1, 3, 5]
            },
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2,
            new_column: "woot"
        }

        const expectedResponse = [
            {
                id: 1,
                data: {
                    something: "somethingstring",
                    ids: [1, 3, 5]
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2,
                new_column: '"woot"'
            }
        ]

        await new Promise<void>((resolve, reject) => {
            serve(baseUrl())
                .put("/testComponent/1")
                .send(request)
                .end((err: unknown, res: ChaiHttp.Response) => {
                    if (err) {
                        reject(err instanceof Error ? err : new Error(String(err)))
                        return
                    }

                    try {
                        assert.deepEqual(res.body, expectedResponse)
                        resolve()
                    } catch (e) {
                        reject(e instanceof Error ? e : new Error(String(e)))
                    }
                })
        })
    })
})
