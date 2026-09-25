import chai from "chai"
import { assert, expect } from "chai"
import chaiHttp from "chai-http"
import { spawn } from "child_process"
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

    it("POST sql runs a query", function (done: any) {
        chai.request(baseEndPoint)
            .post("/sql")
            .send({ query: "SELECT id FROM testcomponent WHERE id = 1" })
            .end((err, res) => {
                assert.equal(res.status, 200)
                expect(res.body).to.eql([{ id: 1 }])
                done()
            })
    })

    it("POST sql rejects an empty query", function (done: any) {
        chai.request(baseEndPoint)
            .post("/sql")
            .send({ query: "   " })
            .end((err, res) => {
                assert.equal(res.status, 400)
                expect(res.text).to.equal("Missing query property.")
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

    it("PUT and DEL a subcomponent", function (done: any) {
        const request = {
            data: {
                something: "subcomponent updated"
            },
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2
        }

        chai.request(baseEndPoint)
            .put("/testComponent/sub/1")
            .send(request)
            .end((err, res) => {
                assert.equal(res.status, 200)
                expect(res.body[0].data.something).to.equal("subcomponent updated")
                chai.request(baseEndPoint)
                    .del("/testComponent/sub/1")
                    .end((delErr, delRes) => {
                        assert.equal(delRes.status, 200)
                        chai.request(baseEndPoint)
                            .get("/testComponent/sub/1")
                            .end((getErr, getRes) => {
                                assert.equal(getRes.status, 200)
                                expect(getRes.body).to.eql([])
                                done()
                            })
                    })
            })
    })

    it("DEL all entries without dropping the table", function (done: any) {
        const request = {
            data: {
                something: "temporary"
            },
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2
        }

        chai.request(baseEndPoint)
            .post("/wipeComponent")
            .send(request)
            .end((err, res) => {
                assert.equal(res.status, 200)
                chai.request(baseEndPoint)
                    .del("/wipeComponent/all")
                    .end((delErr, delRes) => {
                        assert.equal(delRes.status, 200)
                        chai.request(baseEndPoint)
                            .get("/wipeComponent/all")
                            .end((getErr, getRes) => {
                                assert.equal(getRes.status, 200)
                                expect(getRes.body).to.eql([])
                                done()
                            })
                    })
            })
    })

    it("POST sql rejects a bad query", function (done: any) {
        chai.request(baseEndPoint)
            .post("/sql")
            .send({ query: "SELECT * FROM table_that_does_not_exist" })
            .end((err, res) => {
                assert.equal(res.status, 500)
                done()
            })
    })

    it("GET parents, children, and references", function (done: any) {
        const child = {
            data: {
                parentId: 1
            },
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2
        }
        const reference = {
            data: {
                links: [1]
            },
            date_created: created,
            date_modified: modified,
            created_by: 2,
            modified_by: 2
        }

        chai.request(baseEndPoint)
            .post("/testComponent")
            .send(child)
            .end((err, res) => {
                assert.equal(res.status, 200)
                const childId = res.body[0].id
                chai.request(baseEndPoint)
                    .post("/refHolder")
                    .send(reference)
                    .end((refErr, refRes) => {
                        assert.equal(refRes.status, 200)
                        chai.request(baseEndPoint)
                            .get("/testComponent/1")
                            .query({ children: "parentId" })
                            .end((childErr, childRes) => {
                                assert.equal(childRes.status, 200)
                                expect(childRes.body.map((row: { id: number }) => row.id)).to.eql([1, childId])
                                chai.request(baseEndPoint)
                                    .get(`/testComponent/${childId}`)
                                    .query({ parents: "parentId" })
                                    .end((parentErr, parentRes) => {
                                        assert.equal(parentRes.status, 200)
                                        expect(parentRes.body.map((row: { id: number }) => row.id)).to.eql([childId, 1])
                                        chai.request(baseEndPoint)
                                            .get("/testComponent/1")
                                            .query({ referenceComponent: "refholder", referencePath: "links" })
                                            .end((referenceErr, referenceRes) => {
                                                assert.equal(referenceRes.status, 200)
                                                expect(referenceRes.body[0].data.links).to.eql([1])
                                                done()
                                            })
                                    })
                            })
                    })
            })
    })

    it("CLI exits when the database cannot be created", function (done: any) {
        this.timeout(10000)
        const child = spawn(process.execPath, ["--loader", "ts-node/esm", "src/scribe.cli.ts"], {
            env: {
                ...process.env,
                TS_NODE_TRANSPILE_ONLY: "1",
                SCRIBE_APP_DB_HOST: "localhost",
                SCRIBE_APP_DB_PORT: "1",
                SCRIBE_APP_DB_USER: "postgres",
                SCRIBE_APP_DB_NAME: "test"
            }
        })
        let output = ""
        child.stdout.on("data", (buf: Buffer) => {
            output += buf.toString()
        })
        child.stderr.on("data", (buf: Buffer) => {
            output += buf.toString()
        })

        child.on("exit", (code) => {
            assert.equal(code, 1)
            expect(output).to.not.include("Scribe - Process")
            done()
        })
    })

    it("CLI replaces a worker that exits", function (done: any) {
        this.timeout(20000)
        const child = spawn(process.execPath, ["--loader", "ts-node/esm", "src/scribe.cli.ts"], {
            env: {
                ...process.env,
                TS_NODE_TRANSPILE_ONLY: "1",
                SCRIBE_APP_PORT: "1338",
                SCRIBE_APP_DB_HOST: "localhost",
                SCRIBE_APP_DB_PORT: "5434",
                SCRIBE_APP_DB_USER: "postgres",
                SCRIBE_APP_DB_PASS: "",
                SCRIBE_APP_DB_NAME: "test"
            }
        })
        let output = ""
        let killedWorker = false
        let finished = false

        const finish = (error?: Error) => {
            if (finished) return
            finished = true
            child.kill("SIGTERM")
            if (error) done(error)
            else done()
        }

        const onData = (buf: Buffer) => {
            output += buf.toString()
            const match = output.match(/Scribe - Process: (\d+)/)
            if (match && !killedWorker) {
                killedWorker = true
                process.kill(Number(match[1]), "SIGTERM")
            }
            if (output.includes("Starting a replacement.")) finish()
        }

        child.stdout.on("data", onData)
        child.stderr.on("data", onData)
        child.on("exit", (code) => {
            if (!output.includes("Starting a replacement.")) finish(new Error(`CLI exited early with ${code}: ${output}`))
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
