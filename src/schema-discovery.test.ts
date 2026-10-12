/**
 * Schema discovery, shared by Node (`node --test`) and Bun (`bun test`).
 * Filesystem only: no Postgres, Redis, or Express.
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import {
    componentKeyFromSchemaPath,
    configuredExcludePaths,
    dedupeStrings,
    discoverComponentSchemas,
    mergeExcludePaths,
    normalizeExcludePaths,
    resolveAppHome,
    schemaDiscoveryIgnorePatterns
} from "./schema-discovery.js"

describe("schema discovery", () => {
    it("normalizeExcludePaths splits commas and drops blanks", () => {
        assert.deepEqual(normalizeExcludePaths(null), [])
        assert.deepEqual(normalizeExcludePaths(undefined), [])
        assert.deepEqual(normalizeExcludePaths(""), [])
        assert.deepEqual(normalizeExcludePaths(" vendor , tmp "), ["vendor", "tmp"])
        assert.deepEqual(normalizeExcludePaths(["a, b", "  ", "c"]), ["a", "b", "c"])
    })

    it("dedupeStrings keeps the first occurrence", () => {
        assert.deepEqual(dedupeStrings(["vendor", "tmp", "vendor"]), ["vendor", "tmp"])
    })

    it("mergeExcludePaths keeps CLI entries ahead of env and drops duplicates", () => {
        assert.deepEqual(mergeExcludePaths(["vendor", "generated"], "vendor, tmp"), ["vendor", "generated", "tmp"])
        assert.deepEqual(mergeExcludePaths(undefined, undefined), [])
    })

    it("configuredExcludePaths reads SCRIBE_EXCLUDE_PATHS when env is omitted", () => {
        const previous = process.env.SCRIBE_EXCLUDE_PATHS

        process.env.SCRIBE_EXCLUDE_PATHS = " vendor , tmp "

        try {
            assert.deepEqual(configuredExcludePaths(["generated"]), ["generated", "vendor", "tmp"])
        } finally {
            if (previous === undefined) delete process.env.SCRIBE_EXCLUDE_PATHS
            else process.env.SCRIBE_EXCLUDE_PATHS = previous
        }
    })

    it("resolveAppHome prefers a CLI path, then env, then the working directory", () => {
        assert.equal(resolveAppHome("/tmp/scribe-app", "/tmp/from-env"), path.resolve("/tmp/scribe-app"))
        assert.equal(resolveAppHome("  ", "/tmp/from-env"), path.resolve("/tmp/from-env"))
        assert.equal(resolveAppHome(undefined, undefined), path.resolve("."))
        assert.equal(resolveAppHome(".", "/tmp/from-env"), path.resolve("."))
    })

    it("schemaDiscoveryIgnorePatterns globs directories inside app_home", () => {
        const root = path.join(osTmp(), "scribe-app")

        assert.deepEqual(schemaDiscoveryIgnorePatterns(root, [" vendor ", "nested/gen"]), ["vendor/**", "nested/gen/**"])
        assert.deepEqual(schemaDiscoveryIgnorePatterns(root, [path.join(root, "vendor")]), ["vendor/**"])
        assert.deepEqual(schemaDiscoveryIgnorePatterns(root, ["..foo"]), ["..foo/**"])
    })

    it("blank, dot, and the app root do not ignore every schema file", () => {
        const root = path.join(osTmp(), "scribe-app")
        const warnings = captureWarn(() => {
            const patterns = schemaDiscoveryIgnorePatterns(root, ["", ".", root])

            assert.deepEqual(patterns, [])
        })

        assert.ok(warnings.length >= 2)
        assert.match(warnings.join("\n"), /would ignore all of app_home/)
    })

    it("schemaDiscoveryIgnorePatterns skips paths outside app_home", () => {
        const root = path.join(osTmp(), "scribe-app")
        const outside = "../outside"
        const abs = path.resolve(root, "..", "abs")
        const parent = ".."
        const warnings = captureWarn(() => {
            const patterns = schemaDiscoveryIgnorePatterns(root, [outside, abs, parent])

            assert.deepEqual(patterns, [])
        })

        assert.equal(warnings.length, 3)
        assert.match(warnings[0], /outside app_home/)
        assert.ok(warnings[0].includes(outside))
        assert.match(warnings[1], /outside app_home/)
        assert.ok(warnings[1].includes(abs))
        assert.match(warnings[2], /outside app_home/)
        assert.ok(warnings[2].endsWith(": .."))
    })

    it("derives component keys from paths, including subcomponents", () => {
        const cases: Array<[string, string]> = [
            ["components/Users/Users.schema.json", "Users"],
            ["components/Users/Profile/Profile.schema.json", "Users/Profile"],
            ["components/Users/Profile.schema.json", "Users/Profile"],
            ["components/Products/Inventory/Inventory.schema.json", "Products/Inventory"],
            ["components/Users.schema.json", "Users"],
            ["./components/Users/Users.schema.json", "Users"],
            ["apps/web/components/Users/Profile/Profile.schema.json", "Users/Profile"],
            ["Users/Users.schema.json", "Users"],
            ["Users/Profile/Profile.schema.json", "Users/Profile"],
            ["legacy/Users/Users.schema.json", "legacy/Users"],
            ["components\\Users\\Profile\\Profile.schema.json", "Users/Profile"],
            ["components.schema.json", ""],
            ["notes.json", ""]
        ]

        for (const [file, key] of cases) assert.equal(componentKeyFromSchemaPath(file), key, file)
    })

    it("discovers schema files and skips excludes, node_modules, and unreadable files", () => {
        withTree((root) => {
            writeJson(root, "components/Users/Users.schema.json", { title: "Users" })
            writeJson(root, "components/Users/Profile/Profile.schema.json", { title: "Profile" })
            writeJson(root, "components/Users.schema.json", { title: "duplicate-file" })
            writeJson(root, "components/Hidden/Hidden.schema.json", { title: "Hidden" })
            writeJson(root, "node_modules/pkg/Vendor.schema.json", { title: "Vendor" })
            writeJson(root, ".git/secret/Secret.schema.json", { title: "Secret" })
            writeText(root, "components/Broken/Broken.schema.json", "{")
            writeText(root, "components/List/List.schema.json", "[1, 2]")

            const warnings = captureWarn(() => {
                const found = discoverComponentSchemas(root, ["components/Hidden"])

                assert.equal(found.get("Users") && (found.get("Users") as { title: string }).title, "duplicate-file")
                assert.equal((found.get("Users/Profile") as { title: string }).title, "Profile")
                assert.equal(found.has("Hidden"), false)
                assert.equal(found.has("node_modules/pkg/Vendor"), false)
                assert.equal(found.has("Broken"), false)
                assert.equal(found.has("List"), false)
                assert.equal(found.has(".git/secret/Secret"), false)
            })

            assert.match(warnings.join("\n"), /duplicate component schema for Users/)
            assert.match(warnings.join("\n"), /unreadable schema/)
            assert.match(warnings.join("\n"), /not a JSON object/)
        })
    })

    it("warns and returns nothing when app_home is missing", () => {
        const missing = path.join(osTmp(), "scribe-missing-app-home")
        const warnings = captureWarn(() => {
            assert.equal(discoverComponentSchemas(missing).size, 0)
        })

        assert.match(warnings.join("\n"), /not a directory/)
    })
})

/**
 * @param run
 */
function captureWarn(run: () => void): string[] {
    const warnings: string[] = []
    const original = console.warn

    console.warn = (message?: unknown) => {
        warnings.push(String(message))
    }

    try {
        run()
    } finally {
        console.warn = original
    }

    return warnings
}

/**
 *
 */
function osTmp(): string {
    return tmpdir()
}

/**
 * @param run
 */
function withTree(run: (root: string) => void): void {
    const root = mkdtempSync(path.join(tmpdir(), "scribe-schema-"))

    try {
        run(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

/**
 * @param root
 * @param rel
 * @param schema
 */
function writeJson(root: string, rel: string, schema: object): void {
    writeText(root, rel, JSON.stringify(schema))
}

/**
 * @param root
 * @param rel
 * @param contents
 */
function writeText(root: string, rel: string, contents: string): void {
    const abs = path.join(root, rel)

    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, contents)
}
