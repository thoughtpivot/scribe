/**
 * Find component JSON Schemas on disk.
 * Runtime-neutral: Node (`scribe`) and Bun (`scribe-bun`) both call this from core.
 * No Express. Migrations are a separate concern.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const fg = require("fast-glob") as typeof import("fast-glob")

const SCHEMA_SUFFIX = ".schema.json"
const COMPONENTS_DIR = "components"
const BUILTIN_IGNORES = ["**/node_modules/**", "**/.git/**"]

/**
 * Turn a CLI value or env string into trimmed, comma-split directory names.
 *
 * @param value
 */
export function normalizeExcludePaths(value: unknown): string[] {
    if (value === null || value === undefined || value === "") return []

    const parts = Array.isArray(value) ? value : [value]
    const out: string[] = []

    for (const part of parts) {
        const text = String(part).trim()
        if (!text) continue

        out.push(
            ...text
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
        )
    }

    return out
}

/**
 * Preserve first-seen order while dropping duplicate strings.
 *
 * @param items
 */
export function dedupeStrings(items: string[]): string[] {
    return [...new Set(items)]
}

/**
 * Combine CLI and `SCRIBE_EXCLUDE_PATHS` values, CLI first, without duplicates.
 * `SCRIBE_APP_EXCLUDE_PATHS` is already applied by yargs before `cliValue` arrives.
 *
 * @param cliValue
 * @param envValue
 */
export function mergeExcludePaths(cliValue: unknown, envValue: unknown): string[] {
    return dedupeStrings([...normalizeExcludePaths(cliValue), ...normalizeExcludePaths(envValue)])
}

/**
 * Exclude list for schema discovery. CLI flags win, then `SCRIBE_EXCLUDE_PATHS`.
 *
 * @param cliValue
 * @param envValue
 */
export function configuredExcludePaths(cliValue: unknown, envValue: unknown = process.env.SCRIBE_EXCLUDE_PATHS): string[] {
    return mergeExcludePaths(cliValue, envValue)
}

/**
 * Absolute `--app_home`. A non-empty CLI value wins, then `SCRIBE_APP_APP_HOME`, then `.`.
 * yargs copies `SCRIBE_APP_APP_HOME` onto `argv.app_home` when the process starts.
 *
 * @param cliValue
 * @param envValue
 */
export function resolveAppHome(cliValue: unknown, envValue: unknown = process.env.SCRIBE_APP_APP_HOME): string {
    const fromCli = typeof cliValue === "string" ? cliValue.trim() : ""
    const fromEnv = typeof envValue === "string" ? envValue.trim() : ""

    return path.resolve(fromCli || fromEnv || ".")
}

/**
 * Build fast-glob ignore globs for trees rooted under `appRootAbs`.
 * Entries that resolve outside that root, or to the root itself, are skipped.
 * Folder names are not escaped, so a name like `[abc]` is still a fast-glob pattern.
 *
 * @param appRootAbs
 * @param excludeRelativeDirs
 */
export function schemaDiscoveryIgnorePatterns(appRootAbs: string, excludeRelativeDirs: string[]): string[] {
    const patterns: string[] = []

    for (const raw of excludeRelativeDirs) {
        const trimmed = raw.trim()
        if (!trimmed) continue

        const resolved = path.resolve(appRootAbs, trimmed)
        const rel = path.relative(appRootAbs, resolved)
        const relPosix = rel.replace(/\\/g, "/")

        if (!relPosix) {
            console.warn(`Scribe: exclude_paths entry skipped (would ignore all of app_home): ${trimmed}`)
            continue
        }

        if (relPosix === ".." || relPosix.startsWith("../") || path.isAbsolute(rel)) {
            console.warn(`Scribe: exclude_paths entry skipped (outside app_home): ${trimmed}`)
            continue
        }

        patterns.push(`${relPosix}/**`)
    }

    return patterns
}

/**
 * Component key for a schema path relative to `app_home`, including subcomponents.
 *
 * `components/Users/Users.schema.json` → `Users`
 * `components/Users/Profile/Profile.schema.json` → `Users/Profile`
 * `components/Users/Profile.schema.json` → `Users/Profile`
 *
 * A filename that repeats its parent directory is dropped. The key is the path under
 * the last `components` directory when that directory is present. Casing is kept.
 *
 * @param schemaPath
 */
export function componentKeyFromSchemaPath(schemaPath: string): string {
    const normalized = schemaPath.replace(/\\/g, "/").replace(/^\.\//, "")
    if (!normalized.endsWith(SCHEMA_SUFFIX)) return ""

    const segments = normalized
        .slice(0, -SCHEMA_SUFFIX.length)
        .split("/")
        .filter((segment) => segment && segment !== ".")

    if (segments.length === 0) return ""

    if (segments.length >= 2 && segments[segments.length - 1] === segments[segments.length - 2]) segments.pop()

    const componentsAt = segments.lastIndexOf(COMPONENTS_DIR)
    const keySegments = componentsAt >= 0 ? segments.slice(componentsAt + 1) : segments

    return keySegments.join("/")
}

/**
 * @param err
 */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/**
 * @param value
 */
function isSchemaDocument(value: unknown): value is object {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Read component schema JSON files under `appHome`.
 * The scan matches `.schema.json` at any depth. Later duplicates keep the first file in fast-glob order.
 * Unreadable files are skipped.
 *
 * @param appHome application root to scan
 * @param excludePaths directories under that root to skip
 */
export function discoverComponentSchemas(appHome: string, excludePaths: readonly string[] = []): Map<string, object> {
    const root = path.resolve(appHome || ".")
    const found = new Map<string, object>()
    const filesByKey = new Map<string, string>()

    if (!existsSync(root) || !statSync(root).isDirectory()) {
        console.warn(`Scribe: app_home is not a directory, skipping schema discovery: ${root}`)
        return found
    }

    const excludes = normalizeExcludePaths([...excludePaths])
    const userIgnores = schemaDiscoveryIgnorePatterns(root, excludes)

    if (userIgnores.length > 0) {
        console.log("Scribe: excluding **/*.schema.json discovery under:", userIgnores.map((pattern) => pattern.replace(/\*\*$/, "")).join(", "))
    }

    let files: string[]

    try {
        files = fg.sync("**/*.schema.json", {
            cwd: root,
            onlyFiles: true,
            dot: false,
            ignore: [...BUILTIN_IGNORES, ...userIgnores]
        })
    } catch (err) {
        console.warn(`Scribe: schema discovery failed under ${root}: ${errorText(err)}`)
        return found
    }

    for (const rel of files) {
        const key = componentKeyFromSchemaPath(rel)
        const abs = path.resolve(root, rel)

        if (!key) {
            console.warn(`Scribe: could not derive a component key from ${rel}`)
            continue
        }

        let parsed: unknown

        try {
            parsed = JSON.parse(readFileSync(abs, "utf8"))
        } catch (err) {
            console.warn(`Scribe: skipping unreadable schema ${abs}: ${errorText(err)}`)
            continue
        }

        if (!isSchemaDocument(parsed)) {
            console.warn(`Scribe: skipping schema that is not a JSON object: ${abs}`)
            continue
        }

        const kept = filesByKey.get(key)

        if (kept) {
            console.warn(`Scribe: duplicate component schema for ${key} at ${abs}; keeping ${kept}`)
            continue
        }

        filesByKey.set(key, abs)
        found.set(key, parsed)
        console.log(`Scribe: found component schema ${key} at ${abs}`)
    }

    if (found.size === 0) console.log(`Scribe: no component schema files under ${root}`)

    return found
}
