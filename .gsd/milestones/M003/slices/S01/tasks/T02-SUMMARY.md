---
id: T02
parent: S01
milestone: M003
key_files:
  - .github/workflows/build-base-image.yml
key_decisions:
  - PR smoke tests rebuild the image locally via GHA cache rather than pulling from GHCR — GHCR push is intentionally skipped on PRs
  - Used docker/metadata-action@v5 for labels on main; explicit tag list for PR local build
  - GHA layer cache (type=gha, mode=max) on both build paths to share layers efficiently
duration: 
verification_result: passed
completed_at: 2026-04-09T15:49:11.112Z
blocker_discovered: false
---

# T02: Created .github/workflows/build-base-image.yml — CI workflow that builds hive-base, runs 5 smoke tests, and pushes :latest + :sha to GHCR on merge to main

**Created .github/workflows/build-base-image.yml — CI workflow that builds hive-base, runs 5 smoke tests, and pushes :latest + :sha to GHCR on merge to main**

## What Happened

Created .github/workflows/build-base-image.yml from scratch with two jobs: a build job (triggers on push/main, pull_request, workflow_dispatch; path-filtered to docker/hive-base/**; builds with push:false+load:true on PRs, push:true with :latest and :sha tags on main) and a smoke-test job (needs: build; pulls image on main, rebuilds locally via GHA cache on PRs; runs 5 smoke tests: claude --version, notesmd-cli --version, act --version, which vncserver, which openbox). Uses docker/build-push-action@v6, GHA layer cache, and packages:write permission for GHCR push.

## Verification

Ran the exact task-plan verification command (file exists + valid YAML + grep checks) — all exited 0. Ran 13 individual must-have checks — all passed.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -f .github/workflows/build-base-image.yml && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-base-image.yml'))" && grep -q 'ghcr.io/kethalia/hive-base' .github/workflows/build-base-image.yml && grep -q 'build-push-action' .github/workflows/build-base-image.yml && grep -q 'packages: write' .github/workflows/build-base-image.yml` | 0 | ✅ pass | 300ms |

## Deviations

Smoke-test job rebuilds image on PRs rather than reusing build job's local daemon — required because GitHub Actions jobs run on separate ephemeral runners with no shared Docker daemon state.

## Known Issues

Workflow not yet run in CI — smoke test failures will only surface on first push/PR.

## Files Created/Modified

- `.github/workflows/build-base-image.yml`
