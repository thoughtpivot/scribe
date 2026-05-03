import { Signer } from "@aws-sdk/rds-signer"
import { RedisClientType } from "@redis/client"
import { Ajv, ValidateFunction } from "ajv"
import formatsPlugin from "ajv-formats"
import { diff_match_patch } from "diff-match-patch"
import dotenv from "dotenv"
import express from "express"
import { Server } from "http"
import { DateTime } from "luxon"
import { mkdirp } from "mkdirp"
import { createRequire } from "module"
import fetch from "node-fetch"
import pgPromise from "pg-promise"
import pgtools, { PgtoolsError } from "pgtools"
import pluralize from "pluralize"
import { createClient } from "redis"
import urlJoin from "url-join"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"

dotenv.config()

import { getErrorMessage, isPgPromiseError } from "./errors.js"

const get = (p: string, o: any): any => p.split(".").reduce((xs: any, x: any) => (xs && xs[x] ? xs[x] : null), o)
const require = createRequire(import.meta.url)

const argv = yargs(hideBin(process.argv))
    .env("SCRIBE_APP")
    .option("n", {
        alias: "name",
        default: process.env.HOSTNAME || "localhost"
    })
    .option("m", {
        alias: "mode",
        default: process.env.NODE_ENV || "development"
    })
    .option("h", {
        alias: "home",
        default: process.cwd()
    })
    .option("p", {
        alias: "port",
        default: 1337
    })
    .option("useIamConnection", {
        default: false
    })
    .option("dbHost", {
        default: "localhost"
    })
    .option("dbPass", {
        default: ""
    })
    .option("dbUser", {
        default: ""
    })
    .option("dbPort", {
        default: 5432
    })
    .option("dbName", {
        default: "scribe"
    })
    .option("useSSL", {
        default: false
    })
    .option("requireSchema", {
        default: false
    })
    .option("redisHost", {
        default: "127.0.0.1"
    })
    .option("redisPort", {
        default: 6379
    })
    .option("redisSchemaDb", {
        default: 1
    })
    .option("redisReconnectTimeout", {
        default: 5000
    })
    .option("payloadLimit", {
        default: "50mb"
    })
    .option("schemaBaseUrl", {
        type: "string"
    })
    .parseSync()

interface ComponentSchema {
    schema: object
    validator: ValidateFunction
}

const dbConnectionConfig = async () => {
    let pass: string | (() => Promise<string>) = argv.dbPass
    // NOTE: If you want strict cert checking this should be updated to take paths to ca certs
    // https://node-postgres.com/features/ssl#self-signed-cert
    let ssl = argv.useSSL
        ? {
              rejectUnauthorized: false
          }
        : undefined

    if (argv.useIamConnection) {
        try {
            const signer = new Signer({
                hostname: argv.dbHost,
                port: argv.dbPort,
                username: argv.dbUser
            })

            pass = () => signer.getAuthToken()
            // NOTE: https://github.com/brianc/node-postgres/issues/1843
            // NOTE: https://github.com/brianc/node-postgres/issues/2009
            ssl = {
                rejectUnauthorized: false
            }
        } catch (e) {
            console.log(e)
        }
    }

    return {
        user: argv.dbUser,
        password: pass,
        port: argv.dbPort,
        host: argv.dbHost,
        ssl
    }
}

/**
 *
 */
export async function tryCreateDb(): Promise<void> {
    try {
        const res = await pgtools.createdb(await dbConnectionConfig(), argv.dbName)
        console.log(res)
    } catch (err) {
        const error = err as PgtoolsError
        if (error.name !== "duplicate_database") throw err
    }
}

/**
 * @param schemaOverride
 */
export async function createServer(schemaOverride: any = undefined): Promise<Server> {
    const dbConnectConfig = Object.assign({}, await dbConnectionConfig(), {
        database: argv.dbName
    })

    const pgp: pgPromise.IMain = pgPromise({})
    const postgresDb: pgPromise.IDatabase<Record<string, never>> = pgp(dbConnectConfig)

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

    const db = new DB(postgresDb, schemaOverride)
    await db.initRedis()
    // NOTE this is a super dangerous route, scribe is meant to only be listening inside a private vpc
    scribe.post("/sql", (req, res, next) => {
        if (typeof req.body.query !== "string") return res.status(400).send("Missing query property.")
        db.executeSqlQuery(req.body.query, res)
    })

    scribe.post("/:component/all", (req, res, next) => {
        // get all
        db.getAll(req.params.component, req.query, req.body, res).then((result) => {
            res.send(result)
        })
        // fail if component doesn't exist
        // returns array always
    })

    scribe.post("/:component/:subcomponent/all", (req, res, next) => {
        // get all
        db.getAll(`${req.params.component}_${req.params.subcomponent}`, req.query, req.body, res).then((result) => {
            res.send(result)
        })
        // fail if component doesn't exist
        // returns array always
    })

    scribe.post("/:component/:subcomponent", async (req, res, next) => {
        const componentSchema = await db.getComponentSchema(`${req.params.component}/${req.params.subcomponent}`)

        if (typeof componentSchema === "string") {
            res.status(500).send(componentSchema)
            return
        }

        // sanity check json body
        if (componentSchema.validator(req.body) === false) {
            res.status(400).send(componentSchema.validator.errors)
            return
        }

        db.createSingle(`${req.params.component}_${req.params.subcomponent}`, req.body as JSON, componentSchema.schema).then((result) => {
            res.send(result)
        })
        // send response success or fail
    })

    scribe.post("/:component", async (req, res, next) => {
        const componentSchema = await db.getComponentSchema(req.params.component)
        if (typeof componentSchema === "string") {
            res.status(500).send(componentSchema)
            return
        }

        // sanity check json body
        if (componentSchema.validator(req.body) === false) {
            res.status(400).send(componentSchema.validator.errors)
            return
        }

        db.createSingle(req.params.component, req.body as JSON, componentSchema.schema).then((result) => {
            res.send(result)
        })

        // send response success or fail
    })

    scribe.get("/:component/:id/history", (req, res, next) => {
        db.getSingleHistory(req.params.component, req.params.id, res).then((result) => {
            res.send(result)
        })
    })

    scribe.get("/:component/:subcomponent/:id/history", (req, res, next) => {
        db.getSingleHistory(`${req.params.component}_${req.params.subcomponent}`, req.params.id, res).then((result) => {
            res.send(result)
        })
    })

    scribe.get("/:component/:subcomponent/all", (req, res, next) => {
        // get all
        db.getAll(`${req.params.component}_${req.params.subcomponent}`, req.query, req.body, res).then((result) => {
            res.send(result)
        })
        // fail if component doesn't exist
        // returns array always
    })

    scribe.get("/:component/all", (req, res, next) => {
        // get all
        db.getAll(req.params.component, req.query, req.body, res).then((result) => {
            res.send(result)
        })
        // fail if component doesn't exist
        // returns array always
    })

    scribe.get("/:component/:subcomponent/:id", (req, res, next) => {
        // get id
        db.getSingle(`${req.params.component}_${req.params.subcomponent}`, req.params.id, req.query, req.body || {}, res).then((result) => {
            res.send(result)
        })
        // fail if component doesn't exist
        // returns array always
    })

    scribe.get("/:component/:id", (req, res, next) => {
        // get id
        db.getSingle(req.params.component, req.params.id, req.query, req.body || {}, res).then((result) => {
            res.send(result)
        })
        // fail if component doesn't exist
        // returns array always
    })

    scribe.put("/:component/:subcomponent/:id", async (req, res, next) => {
        // sanity check json body
        const componentSchema = await db.getComponentSchema(`${req.params.component}/${req.params.subcomponent}`)

        if (typeof componentSchema === "string") {
            res.status(500).send(componentSchema)
            return
        }

        // sanity check json body
        if (componentSchema.validator(req.body) === false) {
            res.status(400).send(componentSchema.validator.errors)
            return
        }

        // update id if it exists
        db.updateSingle(`${req.params.component}_${req.params.subcomponent}`, req.params.id, req.body as JSON, componentSchema.schema, res).then(
            (result) => {
                res.send(result)
            }
        )
    })

    scribe.put("/:component/:id", async (req, res, next) => {
        // sanity check json body
        const componentSchema = await db.getComponentSchema(req.params.component)
        if (typeof componentSchema === "string") {
            res.status(500).send(componentSchema)
            return
        }

        // sanity check json body
        if (componentSchema.validator(req.body) === false) {
            res.status(400).send(componentSchema.validator.errors)
            return
        }

        // update id if it exists
        db.updateSingle(req.params.component, req.params.id, req.body as JSON, componentSchema.schema, res).then((result) => {
            res.send(result)
        })
    })

    scribe.delete("/:component/:subcomponent/all", (req, res, next) => {
        // delete id if it exists
        // fail if it doesn't exist
        db.deleteAll(`${req.params.component}_${req.params.subcomponent}`, res).then((result) => {
            res.send(result)
        })
    })

    scribe.delete("/:component/all", (req, res, next) => {
        // delete id if it exists
        // fail if it doesn't exist
        db.deleteAll(req.params.component, res).then((result) => {
            res.send(result)
        })
    })

    scribe.delete("/:component/:subcomponent/:id", (req, res, next) => {
        // delete id if it exists
        // fail if it doesn't exist
        db.deleteSingle(`${req.params.component}_${req.params.subcomponent}`, req.params.id, res).then((result) => {
            res.send(result)
        })
    })

    scribe.delete("/:component/:id", (req, res, next) => {
        // allow :subcomponent route to fall through
        if (Number.isNaN(Number.parseInt(req.params.id))) {
            next()
            return
        }

        // fail if it doesn't exist
        db.deleteSingle(req.params.component, req.params.id, res).then((result) => {
            res.send(result)
        })
    })

    scribe.delete("/:component/:subcomponent", (req, res, next) => {
        // delete table if it exists
        db.dropTable(`${req.params.component}_${req.params.subcomponent}`, res).then((result) => {
            res.send(result)
        })
        // send response success or fail
    })

    scribe.delete("/:component", (req, res, next) => {
        // delete table if it exists
        db.dropTable(req.params.component, res).then((result) => {
            res.send(result)
        })

        if (req.query.recursive) {
            // TODO find and delete all subcomponents
        }

        // send response success or fail
    })

    scribe.get("/", (req, res, next) => {
        res.statusCode = 200
        res.send()
    })

    scribe.use((req, res) => {
        res.status(400).send("Unhandled Route")
    })

    const scribeServer = await new Promise<Server>((resolve, reject) => {
        const s = scribe.listen(argv.port, () => {
            console.log(
                "Scribe - Process: %sd, Name: %s, Home: %s, Port: %d, Mode: %s, DB Name: %s",
                process.pid,
                argv.name,
                argv.home,
                argv.port,
                argv.mode,
                argv.dbName
            )

            resolve(s)
        })

        s.on("error", reject)
    })

    scribeServer.on("close", () => {
        postgresDb.$pool.end()
    })

    return scribeServer
}

class DB {
    private db: pgPromise.IDatabase<Record<string, never>>
    private defaultSchema: object
    private redisError = false
    private schemaCache: RedisClientType
    /** When set, `createServer(schema)` was called with a concrete schema; skip Redis + HTTP schema services. */
    private readonly schemaSourceIsExplicit: boolean

    constructor(db: pgPromise.IDatabase<Record<string, never>>, schemaOverride: any = undefined) {
        this.db = db
        this.schemaSourceIsExplicit = schemaOverride !== undefined
        this.defaultSchema = schemaOverride ?? require("./default.table.schema.json")
        // @ts-ignore this type sucks
        this.schemaCache = createClient({
            url: `redis://${argv.redisHost}:${argv.redisPort}/${argv.redisSchemaDb}`,
            socket: {
                connectTimeout: argv.redisReconnectTimeout,
                reconnectStrategy: (attempts) => {
                    return Math.min(attempts * 100, 3000)
                }
            }
        })

        this.schemaCache.on("error", (error) => {
            console.log("Failed to connect to Redis database")
            this.redisError = true
        })
    }

    /** Connect and clear schema cache before handling requests (Redis v5 APIs are async). */
    public async initRedis(): Promise<void> {
        if (this.redisError) return
        try {
            await this.schemaCache.connect()
            await this.schemaCache.flushDb()
        } catch {
            this.redisError = true
        }
    }

    public async getComponentSchema(component: string): Promise<ComponentSchema | string> {
        const ajv = new Ajv({
            strict: false,
            loadSchema: async (uri: string): Promise<any> => {
                try {
                    const res = await fetch(uri)
                    return res.json()
                } catch (error) {
                    throw new Error("Loading error: " + error)
                }
            }
        })

        ;(formatsPlugin as unknown as (instance: InstanceType<typeof Ajv>) => void)(ajv)

        const defaultSchema: ComponentSchema = {
            schema: this.defaultSchema,
            validator: ajv.compile(this.defaultSchema)
        }

        if (this.schemaSourceIsExplicit) return defaultSchema

        if (!this.redisError) {
            const storedSchemaString = await this.schemaCache.get(component)

            if (storedSchemaString) {
                try {
                    const schemaObject = JSON.parse(storedSchemaString)
                    const validator = await ajv.compileAsync(schemaObject)
                    return {
                        schema: schemaObject,
                        validator
                    }
                } catch {
                    console.log(`Cached schema for ${component} is corrupt, querying for it again`)
                }
            } else {
                console.log(`No cache entry for ${component} schema, requesting schema from server`)
            }
        } else {
            console.log("Schema cache is unavailable")
        }

        if (!argv.schemaBaseUrl) {
            if (!argv.requireSchema) return defaultSchema

            return "Missing Schema Base Url"
        }

        // TODO should this fall back or error? If scribe can't contact the server then should we be allowing random data in?
        try {
            const schemaUrl = urlJoin(argv.schemaBaseUrl, component, "schema")
            const data = await (await fetch(schemaUrl)).json()

            if (data === null || data === undefined || typeof data !== "object") {
                if (!argv.requireSchema) {
                    console.warn("No schema found, falling back to default schema")
                    return defaultSchema
                }

                return "Failed to get schema at " + schemaUrl
            }

            const validator = await ajv.compileAsync(data)
            if (!this.redisError) this.schemaCache.set(component, JSON.stringify(data))

            return {
                schema: data,
                validator
            }
        } catch (err) {
            console.error(err)
        }

        if (!argv.requireSchema) {
            console.warn("Falling back to default schema")
            return defaultSchema
        }

        return "Failed to look up schema"
    }

    private formatQueryData(data: any, schema: any) {
        const queryData = {
            sqlColumnSchemas: [] as string[],
            sqlColumnNames: [] as string[],
            sqlColumnIndexes: [] as string[],
            dataArray: [] as string[]
        }

        let ignoredKeyCount = 0
        Object.keys(schema.properties).forEach(function (key, index) {
            if (key !== "id") {
                queryData.sqlColumnNames.push(key)
                queryData.sqlColumnIndexes.push(`$${index - ignoredKeyCount + 1}`)
                // TODO sanitize data input
                queryData.dataArray.push(JSON.stringify(data[key]))
                const property = schema.properties[key]

                switch (property.type) {
                    case "integer":
                        queryData.sqlColumnSchemas.push(`${key} integer`)
                        break

                    case "string":
                        if (property.format === "date-time") queryData.sqlColumnSchemas.push(`${key} timestamptz`)
                        else queryData.sqlColumnSchemas.push(`${key} text`)

                        break

                    case "object":
                        queryData.sqlColumnSchemas.push(`${key} jsonb`)
                        break

                    case "number":
                        queryData.sqlColumnSchemas.push(`${key} float8`)
                        break

                    default:
                        break
                }
            } else {
                ignoredKeyCount++
            }
        })

        return queryData
    }

    public async executeSqlQuery(query: string, res: express.Response) {
        try {
            return res.status(200).send(await this.db.query(query))
        } catch (err) {
            return res.status(500).send(getErrorMessage(err))
        }
    }

    public async createSingle(component: string, data: JSON, schema: object): Promise<any> {
        // make table and record for info sent
        const queryData = this.formatQueryData(data, schema)

        const createQuery = `CREATE TABLE IF NOT EXISTS ${component}(id serial PRIMARY KEY, ${queryData.sqlColumnSchemas.join(",")})`

        const createHistoryQuery = `CREATE TABLE IF NOT EXISTS ${component}_history(id serial PRIMARY KEY, foreignKey integer REFERENCES ${component} (id) ON DELETE CASCADE, patches json)`

        const ensureAllColumnsExistQuery = `ALTER TABLE ${component} ADD COLUMN IF NOT EXISTS ${queryData.sqlColumnSchemas.join(
            ", ADD COLUMN IF NOT EXISTS "
        )}`

        const insertQuery = `INSERT INTO ${component}(${queryData.sqlColumnNames.join(",")}) values(${queryData.sqlColumnIndexes.join(
            ","
        )}) RETURNING *`

        const insertHistoryQuery = `INSERT INTO ${component}_history(foreignKey, patches) values($1, CAST ($2 AS JSON)) RETURNING *`
        // TODO do individual try catches so we can roll back the parts that did succeed if needed and so we can res.send error messages
        try {
            await this.db.query(createQuery)
            await this.db.query(createHistoryQuery)
            await this.db.query(ensureAllColumnsExistQuery)
            const result = await this.db.query(insertQuery, queryData.dataArray)
            const resultString = JSON.stringify(result[0])
            const dmp = new diff_match_patch()
            const diff = dmp.patch_make(resultString, "")
            const diffValues = [result[0].id, JSON.stringify([dmp.patch_toText(diff)])]

            // TODO what to do with this history result? Nothing?
            await this.db.query(insertHistoryQuery, diffValues)
            return result
        } catch (err) {
            console.log(err)
            return []
        }
    }
    public async getAll(component: string, query: any, body: any, res: express.Response, parentQuery?: string) {
        try {
            const reqBody = body ?? {}

            let getQuery = `SELECT * FROM ${component}`
            if (!parentQuery) {
                const userFilter = query.filter ? query.filter : reqBody.filter
                const userFilter2 = query.filter2 ? query.filter2 : reqBody.filter2
                const filter2: string[] = []
                if (userFilter2) {
                    for (const filterKey of Object.keys(userFilter2)) {
                        const queryParts = userFilter2[filterKey]
                        if (!Array.isArray(queryParts) || queryParts.length !== 2) {
                            res.sendStatus(400)
                            return
                        }

                        const [operator, value] = queryParts
                        if (typeof operator !== "string") {
                            res.sendStatus(400)
                            return
                        }

                        const keyParts = filterKey.split(".")
                        let columnIdentifier = keyParts.shift()
                        for (let i = 0; i < keyParts.length; i++) columnIdentifier += `->${pgPromise.as.text(keyParts[i])}`

                        let filterValue
                        try {
                            filterValue = JSON.parse(value)
                        } catch {
                            filterValue = value
                        }

                        if (operator === "contains") {
                            if (!Array.isArray(filterValue)) filterValue = [filterValue]

                            // if filter is an empty array the query will return nothing
                            // short circuiting and returning empty array premetively
                            if (filterValue.length === 0) return []
                            filter2.push(pgPromise.as.format("$1:raw @> $2:json", [columnIdentifier, filterValue]))
                        } else if (operator === "is one of") {
                            if (!Array.isArray(filterValue)) {
                                filterValue = filterValue
                            } else {
                                // if filter is an empty array the query will return nothing
                                // short circuiting and returning empty array premetively
                                if (filterValue.length === 0) return []
                                filterValue = filterValue.join(",")
                            }

                            filter2.push(pgPromise.as.format("$1:raw IN ($2:json)", [columnIdentifier, filterValue]))
                        } else {
                            res.sendStatus(400)
                            return
                        }
                    }
                }

                let rawFilter = undefined
                try {
                    rawFilter = typeof userFilter === "string" ? JSON.parse(userFilter) : userFilter
                } catch {
                    res.status(400)
                    return "Failed to parse filter"
                }

                const filters: string[] = []
                if (rawFilter) {
                    for (const key of Object.keys(rawFilter)) {
                        const keyParts = key.split(".")
                        let filterArray: Array<any>
                        if (rawFilter[key] instanceof Array) filterArray = rawFilter[key] as Array<any>
                        else filterArray = [rawFilter[key]]

                        let filterString = keyParts.shift()
                        filterString = pgPromise.as.value(filterString)

                        for (let i = 0; i < keyParts.length; i++) {
                            const arrow = i === keyParts.length - 1 ? "->>" : "->"
                            filterString += `${arrow}${pgPromise.as.text(keyParts[i])}`
                        }

                        // if filter is an empty array the query will return nothing
                        // short circuiting and returning empty array premetively
                        if (filterArray.length === 0) return []
                        const stringifiedFilterArray = filterArray.map((x) => {
                            if (typeof x !== "string") return `${pgPromise.as.json(x)}`

                            return `${pgPromise.as.text(x)}`
                        })

                        filters.push(`${filterString} IN (${stringifiedFilterArray.join(",")})`)
                    }
                }

                if (filters.length > 0 || filter2.length > 0) getQuery += " WHERE " + [...filters, ...filter2].join(" AND ")

                getQuery += " ORDER BY id"
            } else {
                getQuery = parentQuery
            }

            let filteredResponse: any[] = await this.db.query(getQuery)

            const timeMachineQuery = query.timeMachine ? query.timeMachine : reqBody.timeMachine

            if (timeMachineQuery) {
                let timeMachine: any
                try {
                    timeMachine = JSON.parse(timeMachineQuery)
                } catch {
                    timeMachine = timeMachineQuery
                }

                if (timeMachine.key && timeMachine.timestamp) {
                    const allHistory = await this.getAllHistory(component, filteredResponse, res)

                    if (typeof allHistory !== "string") {
                        const timestamp = DateTime.fromISO(timeMachine.timestamp)

                        filteredResponse = allHistory.map((history) => {
                            history.history.sort((a: any, b: any) => {
                                const aDate = DateTime.fromISO(get(timeMachine.key, a))
                                const bDate = DateTime.fromISO(get(timeMachine.key, b))
                                return aDate >= bDate ? -1 : 1
                            })

                            return history.history.find((x: any) => {
                                const xDate = DateTime.fromISO(get(timeMachine.key, x))
                                return xDate <= timestamp
                            })
                        })
                    }
                }
            }

            if (query.groupBy && typeof query.groupBy === "string") {
                filteredResponse = filteredResponse.reduce((grouped, item) => {
                    const key = get(query.groupBy, item)
                    grouped[key] = grouped[key] || []
                    grouped[key].push(item)
                    return grouped
                }, {})
            }

            return filteredResponse
        } catch (err) {
            // relation does not exist so get request is going to return nothing
            if (isPgPromiseError(err) && err.code === "42P01") return []

            console.error(err)
            res.status(500)
            return "Failed to get record"
        }
    }

    public async getSingle(component: string, id: string, query: any, body: any, res: express.Response): Promise<any[] | string | undefined> {
        query.filter = JSON.stringify({
            id
        })

        const parents = query.parents ? query.parents : body.parents
        const parentQuery = parents
            ? `
                with RECURSIVE c as (
                    Select *, 0 as depth from ${component} where id = ${id}
                
                    Union All
                
                    select ${component}.*, c.depth + 1
                    from ${component}
                    JOIN c ON ${component}.id = CAST(c.data ->> '${parents}' as integer)
                )
                
                Select * from c
                ORDER BY depth 
            `
            : undefined

        const children = query.children ? query.children : body.children
        const childQuery = children
            ? `
                with RECURSIVE c as (
                    Select *, 0 as depth from ${component} where id = ${id}
                
                    Union All
                
                    select ${component}.*, c.depth + 1
                    from ${component}
                    JOIN c ON CAST(${component}.data ->> '${children}' as integer) = c.id
                )
                
                Select * from c
                ORDER BY depth 
            `
            : undefined

        const referenceComponent = query.referenceComponent ? query.referenceComponent : body.referenceComponent
        const referencePath = query.referencePath ? query.referencePath : body.referencePath
        const pluralComponent = pluralize(component)
        const referenceQuery = referenceComponent
            ? `
                SELECT *
                FROM ${referenceComponent} a, jsonb_array_elements(a.data->'${referencePath ?? pluralComponent}') b
                WHERE b = '${id}'::jsonb
        
            `
            : undefined

        if (childQuery && parentQuery) {
            res.status(400).send("Cannot query for parents and children at the same time.")
            return "Bad Request"
        }

        if ((childQuery || parentQuery) && referenceQuery) {
            res.status(400).send("Cannot query for parents/children and references at the same time.")
            return "Bad Request"
        }

        try {
            const response = await this.getAll(component, query, body, res, parentQuery ?? childQuery ?? referenceQuery)
            return response
        } catch (err) {
            // relation does not exist so get request is going to return nothing
            if (isPgPromiseError(err) && err.code === "42P01") return []

            console.error(err)
            res.status(500)
            return "Failed to get record"
        }
    }

    public async getSingleHistory(component: string, id: string, res: express.Response): Promise<any[] | string> {
        try {
            let rawHistory = await this.getSingleHistoryRaw(component, id)
            rawHistory = rawHistory[0]
            let currentVersion: any = await this.getSingle(component, id, {}, {}, res)

            currentVersion = JSON.stringify(currentVersion[0])
            const dmp = new diff_match_patch()
            const oldVersions = []
            oldVersions.push(JSON.parse(currentVersion))
            if (rawHistory) {
                // ignore original empty object hence >= 1
                for (let i = rawHistory.patches.length - 1; i >= 1; i--) {
                    try {
                        const nextVersion = dmp.patch_apply(dmp.patch_fromText(rawHistory.patches[i]), currentVersion)[0]
                        oldVersions.push(JSON.parse(nextVersion))
                        currentVersion = nextVersion
                    } catch {
                        continue
                    }
                }
            }

            return oldVersions
        } catch (err) {
            // relation does not exist so get request is going to return nothing
            if (isPgPromiseError(err) && err.code === "42P01") return []

            console.error(err)
            res.status(500)
            return "Failed to get record"
        }
    }

    public async getAllHistory(component: string, entries: any[], res: express.Response): Promise<string | Array<{ id: string; history: any }>> {
        try {
            const allHistory = []
            for (const entry of entries) {
                // TODO speed this up by hitting the db only once
                const history = await this.getSingleHistory(component, entry.id, res)
                if (typeof history !== "string") {
                    allHistory.push({
                        id: entry.id,
                        history: history
                    })
                }
            }

            return allHistory
        } catch (err) {
            // relation does not exist so get request is going to return nothing
            if (isPgPromiseError(err) && err.code === "42P01") return []

            console.error(err)
            res.status(500)
            return "Failed to get records"
        }
    }

    public async updateSingle(component: string, id: string, data: JSON, schema: object, res: express.Response): Promise<any> {
        const queryData = this.formatQueryData(data, schema)

        const updateQuery = `UPDATE ${component} SET (${queryData.sqlColumnNames.join(",")}) = (${queryData.sqlColumnIndexes.join(
            ","
        )}) WHERE id = ${id} RETURNING *`

        const updateHistoryQuery = `UPDATE ${component}_history SET patches = $1 WHERE foreignKey = ${id} RETURNING *`
        const ensureAllColumnsExistQuery = `ALTER TABLE ${component} ADD COLUMN IF NOT EXISTS ${queryData.sqlColumnSchemas.join(
            ", ADD COLUMN IF NOT EXISTS "
        )}`

        const insertHistoryQuery = `INSERT INTO ${component}_history(foreignKey, patches) values($1, CAST ($2 AS JSON)) RETURNING *`
        try {
            const oldVersion = await this.getSingle(component, id, {}, {}, res)
            if (!oldVersion) {
                res.sendStatus(500)
                return
            }

            const oldHistory = await this.getSingleHistoryRaw(component, id)
            await this.db.query(ensureAllColumnsExistQuery)
            const result = await this.db.query(updateQuery, queryData.dataArray)
            const dmp = new diff_match_patch()
            const diff = dmp.patch_make(JSON.stringify(result[0]), JSON.stringify(oldVersion[0]))

            if (!oldHistory || oldHistory.length === 0) {
                const diffValues = [result[0].id, JSON.stringify([dmp.patch_toText(diff)])]

                // TODO what to do with this history result? Nothing?
                await this.db.query(insertHistoryQuery, diffValues)
            } else {
                oldHistory[0].patches.push(dmp.patch_toText(diff))
                // TODO what to do with this history result? Nothing?
                await this.db.query(updateHistoryQuery, JSON.stringify(oldHistory[0].patches))
            }

            return result
        } catch (err) {
            console.error(err)
            res.status(500)
            return "Failed to update record"
        }
    }

    public async deleteSingle(component: string, id: string, res: express.Response): Promise<any> {
        const deleteQuery = `DELETE FROM ${component} WHERE id=$1`
        try {
            const response = await this.db.query(deleteQuery, id)
            return response
        } catch (err) {
            console.error(err)
            res.status(500)
            return "Failed to delete record"
        }
    }

    public async deleteAll(component: string, res: express.Response): Promise<any> {
        const deleteQuery = `TRUNCATE ${component} RESTART IDENTITY CASCADE`
        try {
            const response = await this.db.query(deleteQuery)
            return response
        } catch (err) {
            console.error(err)
            res.status(500)
            return "Failed to delete records"
        }
    }

    public async dropTable(component: string, res: express.Response) {
        const deleteAllQuery = `DROP TABLE IF EXISTS ${component}, ${component}_history`
        try {
            const response = await this.db.query(deleteAllQuery)
            return response
        } catch (err) {
            console.error(err)
            res.status(500)
            return "Failed to drop table"
        }
    }

    private async getSingleHistoryRaw(component: string, id: string) {
        const getQuery = `SELECT * FROM ${component}_history WHERE foreignKey=$1`
        try {
            const response = await this.db.query(getQuery, id)
            return response
        } catch (err) {
            return err
        }
    }
}
