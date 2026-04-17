# S03: CI & Release Workflows — UAT

**Milestone:** M008
**Written:** 2026-04-17T12:55:00.254Z

# S03 UAT: CI & Release Workflows

## Preconditions
- GitHub repository at github.com/kethalia/hive with Actions enabled
- GHCR (GitHub Container Registry) accessible via GITHUB_TOKEN
- Changesets CLI configured (S01 dependency)
- Multi-stage Dockerfiles in place (S02 dependency)

## Test Case 1: PR CI Builds Docker Images Without Pushing

**Steps:**
1. Create a feature branch from main
2. Make a code change and add a changeset (`pnpm changeset`)
3. Open a PR targeting main
4. Observe GitHub Actions CI workflow triggers

**Expected:**
- `build-app` job runs and succeeds — builds `ghcr.io/kethalia/hive:ci-{sha}` with `push: false`
- `build-terminal-proxy` job runs in parallel — builds `ghcr.io/kethalia/hive-terminal-proxy:ci-{sha}` with `push: false`
- `changeset-check` job runs and passes (changeset file present)
- `ci-pass` gate job succeeds after all three upstream jobs pass
- No images are pushed to GHCR

## Test Case 2: PR Without Changeset Fails CI

**Steps:**
1. Create a feature branch from main
2. Make a code change WITHOUT adding a changeset
3. Open a PR targeting main

**Expected:**
- `changeset-check` job fails (`pnpm changeset status --since=origin/main` reports missing changeset)
- `ci-pass` gate job fails because changeset-check failed
- Docker builds may still succeed independently

## Test Case 3: CI Concurrency Cancels Stale Builds

**Steps:**
1. Open a PR and let CI start
2. Push another commit to the same PR before CI completes

**Expected:**
- First CI run is cancelled (cancel-in-progress: true)
- Second CI run starts fresh

## Test Case 4: Merging Changesets Opens Version PR

**Steps:**
1. Merge a PR that includes changeset files to main
2. Observe release workflow triggers on push to main

**Expected:**
- `release` job runs changesets/action
- Action detects pending changesets and creates a "chore: version packages" PR
- Version PR contains bumped package.json version(s) and removed changeset files

## Test Case 5: Merging Version PR Triggers Docker Build+Push

**Steps:**
1. Merge the "chore: version packages" PR to main
2. Observe release workflow triggers

**Expected:**
- `release` job runs `pnpm ci:release` (changeset tag) creating git tags
- If hive-orchestrator version was bumped: `docker-app` job builds and pushes `ghcr.io/kethalia/hive` with tags `v{version}`, `sha-{sha}`, `latest`
- If hive-terminal-proxy version was bumped: `docker-terminal-proxy` job builds and pushes `ghcr.io/kethalia/hive-terminal-proxy` with matching tags
- OCI labels (source, description, version, revision, created) are set on images

## Test Case 6: Only Changed Packages Trigger Docker Builds (R081)

**Steps:**
1. Create a changeset that only bumps hive-orchestrator (not terminal-proxy)
2. Merge through the version PR flow

**Expected:**
- `docker-app` job runs (orchestratorVersion is non-empty)
- `docker-terminal-proxy` job is skipped (terminalProxyVersion is empty)
- Only `ghcr.io/kethalia/hive` image is pushed

## Test Case 7: Release Concurrency Does Not Cancel In-Progress

**Steps:**
1. Merge two PRs to main in quick succession

**Expected:**
- Both release workflow runs execute to completion
- Neither cancels the other (cancel-in-progress: false)

## Edge Cases

- **No changesets on main push:** release job runs but changesets/action finds nothing to version — no PR created, no Docker jobs triggered
- **Both packages bumped simultaneously:** both docker-app and docker-terminal-proxy jobs run in parallel
- **Terminal-proxy Dockerfile context:** must be repo root (`.`) with explicit `file: services/terminal-proxy/Dockerfile` — not `services/terminal-proxy` context
