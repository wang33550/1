# Releasing

This project now has a stable release path for GitHub and npm. The only external prerequisites are valid GitHub credentials for pushing tags and a logged-in npm account for publishing.

## Current Release State

- GitHub repository: `https://github.com/wang33550/1`
- current package version: `0.1.1`
- current CLI version: `0.1.1`
- current npm package name candidate: `task-recovery-runtime`

As of `2026-04-19`, `task-recovery-runtime` was not present on npm, so the name appears available. Re-check before publishing.

## Pre-Release Check

Run:

```bash
npm run release:check
```

That script:

- cleans local build output
- reinstalls dependencies
- builds
- tests
- runs `npm pack --dry-run`

## GitHub Release Flow

1. update `CHANGELOG.md`
2. update `package.json` version
3. update CLI version in `src/cli.ts`
4. commit the release
5. create and push a tag

Example:

```bash
git tag -a v0.1.1 -m "v0.1.1"
git push origin main
git push origin v0.1.1
```

Then create a GitHub Release from that tag and use the `0.1.1` changelog section as the release notes base.

## npm Publish Flow

First log in:

```bash
npm adduser
```

Then publish:

```bash
npm publish
```

## Notes

- `prepublishOnly` now forces build and test before `npm publish`
- CI runs build and test on pushes and pull requests
- if you rotate package names or move to a scoped package later, update `README.md`, `package.json`, and this document together
