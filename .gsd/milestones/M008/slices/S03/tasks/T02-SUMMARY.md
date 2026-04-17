---
id: T02
parent: S03
milestone: M008
key_files:
  - .github/workflows/release.yml
  - package.json
key_decisions:
  - Used jq extraction of published package versions from changesets/action output to conditionally gate Docker jobs per-package (R081)
  - Used changeset tag as ci:release publish command — creates git tags for private packages without npm publish (per D034)
duration: 
verification_result: passed
completed_at: 2026-04-17T12:52:55.996Z
blocker_discovered: false
---

# T02: Create release workflow with changesets/action and conditional Docker build+push to GHCR

**Create release workflow with changesets/action and conditional Docker build+push to GHCR**

## What Happened

Created `.github/workflows/release.yml` triggered on push to main. The workflow has three jobs:

1. **release** — Checks out, installs deps, runs `changesets/action@v1` with `pnpm ci:release` as the publish command and `pnpm changeset version` as the version command. When changesets exist, it opens a "chore: version packages" PR. When the version PR is merged, it runs `changeset tag` to create git tags for private packages (no npm publish). Extracts `orchestratorVersion` and `terminalProxyVersion` from the published packages output using jq.

2. **docker-app** — Conditional on `orchestratorVersion != ''` (R081). Logs into GHCR, computes three tags (`v{version}`, `sha-{sha}`, `latest`), builds and pushes `ghcr.io/kethalia/hive` with OCI labels and GHA cache.

3. **docker-terminal-proxy** — Same pattern, conditional on `terminalProxyVersion != ''`. Builds from `services/terminal-proxy/Dockerfile` with repo root context, pushes to `ghcr.io/kethalia/hive-terminal-proxy`.

Added `ci:release` script (`changeset tag`) to root `package.json`. Concurrency group `release-${{ github.ref }}` with `cancel-in-progress: false` ensures releases are never interrupted. All action versions pinned per plan requirements.

## Verification

Ran YAML validation with Python yaml.safe_load — valid. Ran 8 grep checks for changesets/action@v1, hive-orchestrator, hive-terminal-proxy, push: true, cancel-in-progress: false, both GHCR image prefixes. Verified ci:release script exists in package.json via Node.js require check. All 9 checks passed.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('valid yaml')"` | 0 | ✅ pass | 200ms |
| 2 | `grep -q 'changesets/action@v1' .github/workflows/release.yml` | 0 | ✅ pass | 10ms |
| 3 | `grep -q 'hive-orchestrator' .github/workflows/release.yml` | 0 | ✅ pass | 10ms |
| 4 | `grep -q 'hive-terminal-proxy' .github/workflows/release.yml` | 0 | ✅ pass | 10ms |
| 5 | `grep -q 'push: true' .github/workflows/release.yml` | 0 | ✅ pass | 10ms |
| 6 | `grep -q 'cancel-in-progress: false' .github/workflows/release.yml` | 0 | ✅ pass | 10ms |
| 7 | `grep -q 'ghcr.io/kethalia/hive:' .github/workflows/release.yml` | 0 | ✅ pass | 10ms |
| 8 | `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:' .github/workflows/release.yml` | 0 | ✅ pass | 10ms |
| 9 | `node -e "const p=require('./package.json'); if(!p.scripts['ci:release']) process.exit(1)"` | 0 | ✅ pass | 50ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `.github/workflows/release.yml`
- `package.json`
