import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { FlatCompat } from "@eslint/eslintrc"
import js from "@eslint/js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
})

const legacy = JSON.parse(readFileSync(path.join(__dirname, "eslint.legacy.json"), "utf8"))

export default [{ ignores: ["dist/**", "node_modules/**", "eslint.config.js"] }, ...compat.config(legacy)]
