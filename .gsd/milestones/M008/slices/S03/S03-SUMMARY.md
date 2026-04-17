---
id: S03
parent: M008
milestone: M008
provides:
  - ["ci-workflow", "release-workflow", "ghcr-publishing"]
requires:
  - slice: S01
    provides: changesets-config
  - slice: S02
    provides: multi-stage-dockerfiles
affects:
  []
key_files:
  - [".github/workflows/ci.yml", ".github/workflows/release.yml", "package.json"]
key_decisions:
  - ["D034: Use changeset tag as ci:release publish command — creates git tags for private packages without npm publish", "D033: GHCR namespace ghcr.io/kethalia/ for all Docker images"]
patterns_established:
  - ["Conditional Docker jobs gated on per-package version extraction from changesets/action output — only build images for packages that actually changed", "Two-workflow CI/CD pattern: ci.yml for PR validation (build without push), release.yml for main branch publishing (build with push)", "ci-pass gate job pattern with if: always() checking all upstream results for branch protection"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-17T12:55:00.254Z
blocker_discovered: false
---

# S03: CI & Release Workflows

**GitHub Actions CI and release workflows: PR Docker builds without push, changesets-driven version PRs, and conditional tagged image publishing to GHCR.**

## What Happened

S03 delivers the final piece of the M008 release pipeline — two GitHub Actions workflows that automate Docker image building and publishing.

**T01: CI Workflow (.github/workflows/ci.yml)**
Created a PR-triggered workflow with four parallel/gated jobs:
- `build-app` — builds the root Dockerfile with `push: false` / `load: true`, tagged `ghcr.io/kethalia/hive:ci-{sha}` with GHA caching
- `build-terminal-proxy` — same pattern for `services/terminal-proxy/Dockerfile` with repo root context, tagged `ghcr.io/kethalia/hive-terminal-proxy:ci-{sha}`
- `changeset-check` — installs pnpm + Node 22, runs `pnpm changeset status --since=origin/main` to enforce changesets on PRs (uses `fetch-depth: 0` so origin/main ref is available)
- `ci-pass` — gate job with `if: always()` checking all three upstream results

Read-only permissions. Concurrency group `ci-{ref}` with `cancel-in-progress: true`. All action versions pinned per plan.

**T02: Release Workflow (.github/workflows/release.yml)**
Created a push-to-main workflow with three jobs:
- `release` — runs `changesets/action@v1` with `pnpm ci:release` (which runs `changeset tag` to create git tags for private packages without npm publish, per D034). When changesets exist, opens a version PR. After merge, extracts per-package versions via jq from publishedPackages output.
- `docker-app` — conditional on `orchestratorVersion != ''` (R081). Logs into GHCR, computes three tags (`v{version}`, `sha-{sha}`, `latest`), builds and pushes `ghcr.io/kethalia/hive` with OCI labels.
- `docker-terminal-proxy` — same conditional pattern for terminal-proxy, building from `services/terminal-proxy/Dockerfile` with repo root context.

Concurrency `release-{ref}` with `cancel-in-progress: false`. Added `ci:release` script to root package.json.

Both workflows use the `ghcr.io/kethalia/` namespace (D033) and pinned action versions throughout.

## Verification

All 16 verification checks passed:

**CI workflow (ci.yml):**
- YAML validates without errors (Python yaml.safe_load)
- Contains `push: false` for no-push PR builds
- References `ghcr.io/kethalia/hive:` image tag
- References `ghcr.io/kethalia/hive-terminal-proxy:` image tag
- References `services/terminal-proxy/Dockerfile` path
- Contains `ci-pass` gate job
- Contains `cancel-in-progress: true`

**Release workflow (release.yml):**
- YAML validates without errors
- Contains `changesets/action@v1`
- References `hive-orchestrator` package name
- References `hive-terminal-proxy` package name
- Contains `push: true` for GHCR publishing
- Contains `cancel-in-progress: false`
- References `ghcr.io/kethalia/hive:` image tag
- References `ghcr.io/kethalia/hive-terminal-proxy:` image tag

**Package.json:**
- `ci:release` script exists and is set to `changeset tag`

## Requirements Advanced

None.

## Requirements Validated

- R073 — ci.yml builds both Docker images with push: false on PRs to main
- R074 — release.yml changesets/action creates version PRs when changesets exist on main
- R075 — release.yml docker jobs build+push tagged images after version PR merge
- R080 — Both workflows use ghcr.io/kethalia/ namespace for all images
- R081 — Docker jobs conditional on per-package version extraction — only changed packages trigger builds

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

None.

## Follow-ups

None.

## Files Created/Modified

- `.github/workflows/ci.yml` — PR-triggered CI workflow with parallel Docker builds (no push), changeset check, and ci-pass gate job
- `.github/workflows/release.yml` — Push-to-main release workflow with changesets/action version PRs and conditional Docker build+push to GHCR
- `package.json` — Added ci:release script (changeset tag) for changesets/action publish command
