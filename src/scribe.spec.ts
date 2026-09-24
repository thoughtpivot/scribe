import chai from "chai"
import { assert, expect } from "chai"
import chaiHttp from "chai-http"
import { DateTime } from "luxon"
import { createRequire } from "module"
import { Server } from "net"

import { createServer, tryCreateDb } from "./scribe.js"

chai.use(chaiHttp)

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
        chai.request(baseEndPoint)
            .get("/")
            .end((err, res) => {
                assert.equal(res.status, 200)
                done()
            })
    })

    it("DEL component table", function (done: any) {
        chai.request(baseEndPoint)
            .del("/testComponent")
            .end((err, res) => {
                assert.equal(res.status, 200)
                expect(res.body).to.eql([])
                done()
            })
    })

    it("DEL subcomponent table", function (done: any) {
        chai.request(baseEndPoint)
            .del("/testComponent/sub")
            .end((err, res) => {
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

        chai.request(baseEndPoint)
            .post("/testComponent")
            .send(request)
            .end((err, res) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("POST rejects a record missing required fields", function (done: any) {
        chai.request(baseEndPoint)
            .post("/testComponent")
            .send({})
            .end((err, res) => {
                assert.equal(res.status, 400)
                done()
            })
    })

    it("POST and GET a subcomponent", function (done: any) {
        const request = {
            data: {
                something: "subcomponentstring"
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
                    something: "subcomponentstring"
                },
                date_created: created,
                date_modified: modified,
                created_by: 2,
                modified_by: 2
            }
        ]

        chai.request(baseEndPoint)
            .post("/testComponent/sub")
            .send(request)
            .end((err, res) => {
                assert.equal(res.status, 200)
                assert.deepEqual(res.body, expectedResponse)
                chai.request(baseEndPoint)
                    .get("/testComponent/sub/1")
                    .end((getErr, getRes) => {
                        assert.equal(getRes.status, 200)
                        assert.deepEqual(getRes.body, expectedResponse)
                        done()
                    })
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

        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .end((err, res) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET one entry by id", function (done: any) {
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

        chai.request(baseEndPoint)
            .get("/testComponent/1")
            .end((err, res) => {
                assert.equal(res.status, 200)
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

        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .query({ filter: { created_by: [2] } })
            .end((err, res) => {
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

        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .query({ filter2: { id: ["is one of", [1]] } })
            .end((err, res) => {
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

        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .query({ filter2: { "data.something": ["is one of", "somethingstring"] } })
            .end((err, res) => {
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

        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .query({ filter2: { "data.ids": ["contains", [3]] } })
            .end((err, res) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with query filter expect none", function (done: any) {
        const expectedResponse: any[] = []
        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .send({ filter: { created_by: [3] } })
            .end((err, res) => {
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

        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .send({ filter: { created_by: [2] } })
            .end((err, res) => {
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

        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .send({ filter: { "data.something": "somethingstring" } })
            .end((err, res) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET all entries with body filter expect none", function (done: any) {
        const expectedResponse: any[] = []
        chai.request(baseEndPoint)
            .get("/testComponent/all")
            .query({ filter: { created_by: [3] } })
            .end((err, res) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET from table that doesn't exist should return empty array", function (done: any) {
        const expectedResponse: any[] = []
        chai.request(baseEndPoint)
            .get("/someTableThatDoesntExist/all")
            .end((err, res) => {
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

        chai.request(baseEndPoint)
            .put("/testComponent/1")
            .send(request)
            .end((err, res) => {
                assert.deepEqual(res.body, expectedResponse)
                done()
            })
    })

    it("GET entry history", function (done: any) {
        chai.request(baseEndPoint)
            .get("/testComponent/1/history")
            .end((err, res) => {
                assert.equal(res.status, 200)
                expect(res.body).to.be.an("array")
                expect(res.body[0].id).to.equal(1)
                expect(res.body[0].data.something).to.equal("we changed this")
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

            chai.request(baseEndPoint)
                .put("/testComponent/1")
                .send(request)
                .end((err, res) => {
                    assert.deepEqual(res.body, expectedResponse)
                    done()
                })
        })
    })

    it("DEL one entry by id", function (done: any) {
        chai.request(baseEndPoint)
            .del("/testComponent/1")
            .end((err, res) => {
                assert.equal(res.status, 200)
                chai.request(baseEndPoint)
                    .get("/testComponent/1")
                    .end((getErr, getRes) => {
                        assert.equal(getRes.status, 200)
                        expect(getRes.body).to.eql([])
                        done()
                    })
            })
    })
})
