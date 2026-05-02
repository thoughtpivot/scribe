import "chai-http"

import * as chaiMod from "chai"
import chaiHttp from "chai-http"
import { DateTime } from "luxon"
import { createRequire } from "module"
import { Server } from "net"

import { createServer, tryCreateDb } from "./scribe.js"

chaiMod.use(chaiHttp)

const chai = chaiMod as unknown as Chai.ChaiStatic
const { assert, expect } = chaiMod

/** chai-http exposes request as callable at runtime; DefinitelyTyped omits call signature */
const serve = chai.request as unknown as (url: string) => ChaiHttp.Agent

const baseEndPoint = "http://localhost:1337"
let server: Server | undefined

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
    server?.close()
    done()
})

describe("Scribe", function () {
    it("Checks that server is running", function (done: any) {
        serve(baseEndPoint)
            .get("/")
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.equal(res.status, 200)
                done()
            })
    })

    it("DEL component table", function (done: any) {
        serve(baseEndPoint)
            .del("/testComponent")
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.equal(res.status, 200)
                expect(res.body).to.eql([])
                done()
            })
    })

    it("DEL subcomponent table", function (done: any) {
        serve(baseEndPoint)
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

        serve(baseEndPoint)
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

        serve(baseEndPoint)
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

        serve(baseEndPoint)
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

        serve(baseEndPoint)
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

        serve(baseEndPoint)
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

        serve(baseEndPoint)
            .get("/testComponent/all")
            .query({ filter2: { "data.ids": ["contains", [3]] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with query filter expect none", function (done: any) {
        const expectedResponse: any[] = []
        serve(baseEndPoint)
            .get("/testComponent/all")
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

        serve(baseEndPoint)
            .get("/testComponent/all")
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

        serve(baseEndPoint)
            .get("/testComponent/all")
            .send({ filter: { "data.something": "somethingstring" } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with body filter expect none", function (done: any) {
        const expectedResponse: any[] = []
        serve(baseEndPoint)
            .get("/testComponent/all")
            .query({ filter: { created_by: [3] } })
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET from table that doesn't exist should return empty array", function (done: any) {
        const expectedResponse: any[] = []
        serve(baseEndPoint)
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

        serve(baseEndPoint)
            .put("/testComponent/1")
            .send(request)
            .end((err: unknown, res: ChaiHttp.Response) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("PUT with schema change", function (done: any) {
        server?.close(async () => {
            const newSchema = schema
            newSchema.required.push("new_column")
            newSchema.properties["new_column"] = {
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

            serve(baseEndPoint)
                .put("/testComponent/1")
                .send(request)
                .end((err: unknown, res: ChaiHttp.Response) => {
                    assert.deepEqual(res.body, expectedResponse)
                    done()
                })
        })
    })
})
