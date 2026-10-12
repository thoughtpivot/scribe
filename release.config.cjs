/**
 * semantic-release for @thoughtpivot/scribe.
 *
 * The npm plugin's prepare step runs `npm version`, which refuses a dirty
 * worktree. It is ordered before the changelog plugin so the version bump
 * happens before CHANGELOG.md is rewritten.
 */
module.exports = {
    branches: ["master"],
    tagFormat: "v${version}",
    plugins: [
        [
            "@semantic-release/commit-analyzer",
            {
                preset: "conventionalcommits",
                releaseRules: [
                    { breaking: true, release: "major" },
                    { type: "feat", release: "minor" },
                    { type: "fix", release: "patch" },
                    { type: "chore", release: false },
                ],
            },
        ],
        [
            "@semantic-release/release-notes-generator",
            {
                preset: "conventionalcommits",
            },
        ],
        [
            // @semantic-release/npm@13 verifies and publishes with GitHub
            // OIDC trusted publishing. Leave NPM_TOKEN unset.
            "@semantic-release/npm",
            {
                npmPublish: true,
            },
        ],
        [
            "@semantic-release/changelog",
            {
                changelogFile: "CHANGELOG.md",
                changelogTitle: "# Changelog",
            },
        ],
        [
            "@semantic-release/git",
            {
                assets: ["package.json", "package-lock.json", "CHANGELOG.md"],
                message: "chore(release): ${nextRelease.version} [skip ci]",
            },
        ],
        [
            "@semantic-release/github",
            {
                successComment: false,
                failComment: false,
                failTitle: false,
                releasedLabels: false,
            },
        ],
    ],
};
