# S01: Changesets Setup

**Goal:** Changesets CLI installed and configured for independent versioning across the Hive monorepo, with convenience scripts in root package.json.
**Demo:** pnpm changeset creates a changeset file; pnpm changeset version bumps the correct package.json independently

## Must-Haves

- `pnpm changeset` creates a changeset file in `.changeset/`
- `pnpm changeset version` bumps the correct package.json version independently
- `.changeset/config.json` uses independent versioning, restricted access, and `privatePackages.version: true`
- No npm publish capability (both packages are private, access restricted)
- `changeset` and `changeset:version` scripts exist in root package.json

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [x] **T01: Install changesets CLI, initialize config, and add convenience scripts** `est:15m`
  Install @changesets/cli as a root devDependency, initialize the .changeset/ directory, configure config.json for independent versioning with no npm publish, and add changeset convenience scripts to root package.json.

This is the only task for this slice — the scope is small enough to complete in one pass.

Context:
- Workspace has two private packages: `hive-orchestrator` (root) and `hive-terminal-proxy` (`services/terminal-proxy`)
- Both are `private: true` — no npm publishing
- D032: independent versioning (not fixed)
- D034: no npm publish — changesets for version tracking and Docker image tagging only
- pnpm workspace config at `pnpm-workspace.yaml` includes `.` and `services/*`

Steps:
1. Run `pnpm add -Dw @changesets/cli` to install as root devDependency
2. Run `pnpm changeset init` to create `.changeset/` directory with default config and README
3. Replace `.changeset/config.json` with the target config:
   - `changelog`: `@changesets/cli/changelog` (built-in, no GitHub token needed)
   - `commit`: false
   - `fixed`: [] (independent versioning per D032)
   - `linked`: []
   - `access`: `restricted` (prevent accidental publish)
   - `baseBranch`: `main`
   - `updateInternalDependencies`: `patch`
   - `ignore`: []
   - `privatePackages`: `{ "version": true, "tag": true }` (bump versions for private packages)
4. Add two scripts to root `package.json`:
   - `"changeset": "changeset"`
   - `"changeset:version": "changeset version"`
5. Verify: run `pnpm changeset --help` to confirm CLI works
6. Verify: confirm `.changeset/config.json` has correct values
7. Verify: confirm root `package.json` has both new scripts
  - Files: `.changeset/config.json`, `.changeset/README.md`, `package.json`, `pnpm-lock.yaml`
  - Verify: pnpm changeset --help && test -f .changeset/config.json && node -e "const c = require('./.changeset/config.json'); const assert = require('assert'); assert.strictEqual(c.access, 'restricted'); assert.deepStrictEqual(c.fixed, []); assert.strictEqual(c.privatePackages.version, true); assert.strictEqual(c.baseBranch, 'main');" && node -e "const p = require('./package.json'); const assert = require('assert'); assert.ok(p.scripts.changeset); assert.ok(p.scripts['changeset:version']);"

## Files Likely Touched

- .changeset/config.json
- .changeset/README.md
- package.json
- pnpm-lock.yaml
