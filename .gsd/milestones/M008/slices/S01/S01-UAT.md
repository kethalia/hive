# S01: Changesets Setup — UAT

**Milestone:** M008
**Written:** 2026-04-17T12:34:20.898Z

# S01 UAT: Changesets Setup

## Preconditions
- Working directory is the hive monorepo root
- `pnpm install` has been run (node_modules populated)

## Test Cases

### TC1: Changeset CLI is available
1. Run `pnpm changeset --help`
2. **Expected:** Exits 0, prints changeset usage/help text

### TC2: Config uses independent versioning
1. Run `node -e "const c = require('./.changeset/config.json'); console.log(c.fixed)"`
2. **Expected:** Prints `[]` (empty array = independent, not fixed)

### TC3: Config prevents npm publish
1. Run `node -e "const c = require('./.changeset/config.json'); console.log(c.access)"`
2. **Expected:** Prints `restricted`

### TC4: Private packages get version bumps
1. Run `node -e "const c = require('./.changeset/config.json'); console.log(JSON.stringify(c.privatePackages))"`
2. **Expected:** Prints `{"version":true,"tag":true}`

### TC5: Base branch is main
1. Run `node -e "const c = require('./.changeset/config.json'); console.log(c.baseBranch)"`
2. **Expected:** Prints `main`

### TC6: Convenience scripts exist
1. Run `node -e "const p = require('./package.json'); console.log(p.scripts.changeset, p.scripts['changeset:version'])"`
2. **Expected:** Prints `changeset changeset version`

### TC7: Creating a changeset (interactive — manual verification)
1. Run `pnpm changeset` and select a package, choose patch, enter summary
2. **Expected:** A new `.md` file appears in `.changeset/` directory with the summary content

### TC8: Versioning a changeset (manual verification)
1. After TC7, run `pnpm changeset:version`
2. **Expected:** The selected package's `package.json` version is bumped, changeset file is consumed

## Edge Cases
- Running `pnpm changeset version` with no pending changesets should exit cleanly with no changes
- Both packages (hive-orchestrator, hive-terminal-proxy) should be selectable when creating a changeset
