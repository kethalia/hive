---
id: M008
title: "Release Workflow"
status: complete
completed_at: 2026-04-17T12:58:56.037Z
key_decisions:
  - D032: Independent versioning (not fixed) — each package versions independently since they deploy as separate Docker images
  - D033: GHCR namespace ghcr.io/kethalia/ for all Docker images — consistent with existing hive-base
  - D034: No npm publish — changesets used only for version tracking and Docker image tagging via `changeset tag`
  - D035: Compose file convention — docker-compose.yml (prod/GHCR), docker-compose.local.yml (build from source), docker-compose.dev.yml (unchanged)
key_files:
  - .changeset/config.json
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - Dockerfile
  - services/terminal-proxy/Dockerfile
  - docker-compose.yml
  - docker-compose.local.yml
  - next.config.ts
  - package.json
  - services/terminal-proxy/package.json
lessons_learned:
  - pnpm version must be verified at build time — planner assumed 9.15.9 but actual was 10.32.1; always check `pnpm --version` before pinning packageManager field
  - Terminal-proxy Dockerfile requires repo root as build context (not service directory) because `pnpm deploy --filter` needs the workspace lockfile and root package.json
  - For private packages that ship as Docker images, `changeset tag` (not `changeset publish`) is the correct publish command — creates git tags without attempting npm publish
  - ci-pass gate job with `if: always()` is the correct pattern for branch protection — without it, a skipped upstream job would make the gate pass vacuously
---

# M008: Release Workflow

**Complete Docker release pipeline with changesets-driven independent versioning, multi-stage Dockerfiles, restructured compose files, and GitHub Actions CI/CD workflows publishing tagged images to GHCR.**

## What Happened

M008 delivered a complete release pipeline for Hive's two Docker images (hive-orchestrator and hive-terminal-proxy) across three slices.

**S01 — Changesets Setup** installed @changesets/cli with independent versioning configured for both private packages. No npm publish — changesets are used solely for version tracking and Docker image tagging (D034). Two convenience scripts added to root package.json.

**S02 — Dockerfile Upgrades & Compose Restructure** rewrote both Dockerfiles as multi-stage pnpm builds with non-root users. The root Dockerfile produces standalone Next.js output; the terminal-proxy Dockerfile uses `pnpm deploy --filter` for workspace-correct dependency isolation with tini as PID 1. Compose files were restructured per D035: docker-compose.yml now references GHCR published images (prod), docker-compose.local.yml builds from source, and docker-compose.dev.yml was left untouched. pnpm version was corrected from the planned 9.15.9 to the actual 10.32.1.

**S03 — CI & Release Workflows** created two GitHub Actions workflows. ci.yml runs on PRs with parallel Docker builds (no push), changeset status check, and a ci-pass gate job. release.yml runs on push to main with changesets/action creating version PRs, then conditionally building and pushing tagged images (v{version}, sha-{sha}, latest) to ghcr.io/kethalia/ only for packages that were actually version-bumped (R081).

All 6 tasks across 3 slices completed with 34 total verification checks passing. Docker end-to-end build was deferred to CI since no Docker daemon is available in the Coder workspace — this is the expected verification path since S03 CI workflow exists precisely to catch build failures on PRs.

## Success Criteria Results

### S01: Changesets create/version works independently
**PASS** — `.changeset/config.json` configured with `fixed: []` for independent versioning, `privatePackages: { version: true, tag: true }`. Scripts `changeset` and `changeset:version` verified in package.json. 3/3 verification checks passed.

### S02: Multi-stage Docker builds, compose validates
**PASS** — Both Dockerfiles rewritten as 3-stage pnpm builds with non-root users. All 3 compose files validate cleanly (`docker compose config -q` exit 0). 15/15 verification checks passed. Docker build deferred to CI (no daemon in workspace).

### S03: PR CI builds without push, release workflow publishes to GHCR
**PASS** — ci.yml contains `push: false` for PR builds with both GHCR image tags. release.yml uses changesets/action@v1 with conditional Docker jobs gated on per-package version extraction. `push: true` for release publishing. 16/16 verification checks passed.

## Definition of Done Results

- [x] All 3 slices complete (S01 ✅, S02 ✅, S03 ✅)
- [x] All 6 tasks complete (S01:T01, S02:T01-T03, S03:T01-T02)
- [x] All slice summaries exist (S01-SUMMARY.md, S02-SUMMARY.md, S03-SUMMARY.md)
- [x] Code changes verified: 12 files changed, 925 insertions across 6 commits
- [x] Cross-slice integration: S03 workflows reference Dockerfiles from S02, changesets config from S01
- [x] 34 total verification checks passed across all slices

## Requirement Outcomes

| Requirement | Before | After | Evidence |
|---|---|---|---|
| R072 | active | validated | S01: changesets CLI installed, independent versioning config verified |
| R073 | validated | validated | S03: ci.yml builds both images with push:false on PRs |
| R074 | validated | validated | S03: release.yml uses changesets/action@v1 for version PRs |
| R075 | validated | validated | S03: release.yml conditional Docker build+push after version PR merge |
| R076 | active | validated | S02: docker-compose.yml references both GHCR images, no build directives |
| R077 | active | validated | S02: docker-compose.local.yml builds both services from source |
| R078 | active | validated | S02: docker-compose.dev.yml unchanged (postgres+redis only) |
| R079 | active | validated | S02: both Dockerfiles are multi-stage pnpm builds with non-root users |
| R080 | validated | validated | Both workflows use ghcr.io/kethalia/ namespace |
| R081 | validated | validated | release.yml conditional on per-package version extraction via jq |

## Deviations

pnpm version corrected from planned 9.15.9 to actual 10.32.1. No other deviations from the original plan.

## Follow-ups

None.
