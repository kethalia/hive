---
id: T01
parent: S03
milestone: M008
key_files:
  - .github/workflows/ci.yml
key_decisions:
  - Used Python yaml.safe_load for YAML validation since js-yaml is not a project dependency
  - Used fetch-depth: 0 for changeset-check job so origin/main ref is available for changeset status --since
duration: 
verification_result: passed
completed_at: 2026-04-17T12:51:45.122Z
blocker_discovered: false
---

# T01: Add CI workflow with parallel PR Docker builds (no push), changeset check, and ci-pass gate job

**Add CI workflow with parallel PR Docker builds (no push), changeset check, and ci-pass gate job**

## What Happened

Created `.github/workflows/ci.yml` triggered on PRs to main. The workflow runs four jobs:

1. **build-app** — checks out the repo, sets up Buildx, and builds the root `Dockerfile` with `push: false` / `load: true`, tagged `ghcr.io/kethalia/hive:ci-${{ github.sha }}` with GHA caching.
2. **build-terminal-proxy** — same pattern but targets `services/terminal-proxy/Dockerfile` with repo root as build context, tagged `ghcr.io/kethalia/hive-terminal-proxy:ci-${{ github.sha }}`.
3. **changeset-check** — installs pnpm + Node 22, runs `pnpm changeset status --since=origin/main` to enforce changesets on PRs. Uses `fetch-depth: 0` so the origin/main ref is available.
4. **ci-pass** — gate job with `if: always()` and `needs: [build-app, build-terminal-proxy, changeset-check]`. Checks each upstream result and exits 1 if any didn't succeed.

Permissions are read-only (contents + packages). Concurrency group `ci-${{ github.ref }}` with `cancel-in-progress: true` cancels stale PR builds. All action versions pinned per plan: checkout@v4, setup-buildx@v3, build-push-action@v6, action-setup@v4, setup-node@v4.

## Verification

Validated YAML syntax with Python yaml.safe_load (js-yaml not available in project deps). Ran all 7 grep checks from the task plan — push: false, both GHCR image tags, terminal-proxy Dockerfile path, ci-pass gate, and cancel-in-progress. All passed.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('valid yaml')"` | 0 | ✅ pass | 200ms |
| 2 | `grep -q 'push: false' .github/workflows/ci.yml` | 0 | ✅ pass | 5ms |
| 3 | `grep -q 'ghcr.io/kethalia/hive:' .github/workflows/ci.yml` | 0 | ✅ pass | 5ms |
| 4 | `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:' .github/workflows/ci.yml` | 0 | ✅ pass | 5ms |
| 5 | `grep -q 'services/terminal-proxy/Dockerfile' .github/workflows/ci.yml` | 0 | ✅ pass | 5ms |
| 6 | `grep -q 'ci-pass' .github/workflows/ci.yml` | 0 | ✅ pass | 5ms |
| 7 | `grep -q 'cancel-in-progress: true' .github/workflows/ci.yml` | 0 | ✅ pass | 5ms |

## Deviations

YAML validation used Python instead of Node.js js-yaml since the module is not installed in the project. Equivalent validation.

## Known Issues

None

## Files Created/Modified

- `.github/workflows/ci.yml`
