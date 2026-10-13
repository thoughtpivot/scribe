/**
 * KNX-style migration filenames and the up/down stub.
 * Runtime-neutral. No Express.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const FILENAME = /^(\d{14})\.([a-z0-9]+(?:-[a-z0-9]+)*)\.migration\.ts$/

/**
 * UTC timestamp `YYYYMMDDHHmmss`, so filename order is chronological.
 *
 * @param date instant to format
 */
export function migrationTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0")

    return [
        date.getUTCFullYear(),
        pad(date.getUTCMonth() + 1),
        pad(date.getUTCDate()),
        pad(date.getUTCHours()),
        pad(date.getUTCMinutes()),
        pad(date.getUTCSeconds())
    ].join("")
}

/**
 * Lowercase component slug used in the filename. `Users/Profile` becomes `users-profile`.
 *
 * @param component component name from the CLI
 */
export function componentSlug(component: string): string {
    const slug = component
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Component name is required")

    return slug
}

/**
 * `{timestamp}.{component-name}.migration.ts`
 *
 * @param component component name
 * @param date timestamp source, default now
 */
export function migrationFilename(component: string, date = new Date()): string {
    return `${migrationTimestamp(date)}.${componentSlug(component)}.migration.ts`
}

/**
 * Parse a migration filename. Returns undefined when it is not the KNX form.
 *
 * @param filename basename
 */
export function parseMigrationFilename(filename: string): { timestamp: string; component: string } | undefined {
    const match = FILENAME.exec(filename)

    if (!match) return undefined

    return {
        timestamp: match[1],
        component: match[2]
    }
}

/**
 * Stub source with `up` and `down` exports. `run` applies `up` only.
 *
 * @param component component name
 */
export function migrationSource(component: string): string {
    const name = componentSlug(component)

    return `/**
 * ${name}
 * Review up and down, then apply pending migrations with \`scribe run\` or \`scribe-bun run\`.
 * run applies up only. down is the inverse and is not applied by run.
 */

export async function up(db) {
    await db.none("SELECT 1 WHERE false")
}

export async function down(db) {
    await db.none("SELECT 1 WHERE false")
}
`
}

export interface GeneratedMigration {
    filename: string
    path: string
}

/**
 * Write a new migration stub. Does not overwrite an existing file.
 *
 * @param input component, directory, and optional clock
 */
export function generateMigration(input: { component: string; directory: string; now?: Date }): GeneratedMigration {
    const filename = migrationFilename(input.component, input.now ?? new Date())
    const directory = path.resolve(input.directory)
    const filePath = path.join(directory, filename)

    if (existsSync(filePath)) throw new Error(`Migration already exists: ${filePath}`)

    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, migrationSource(input.component))

    return {
        filename,
        path: filePath
    }
}
