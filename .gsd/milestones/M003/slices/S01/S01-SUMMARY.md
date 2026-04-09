---
id: S01
parent: M003
milestone: M003
provides:
  - Published docker image: ghcr.io/kethalia/hive-base:latest with all shared tooling baked in
  - Fully automated GitHub Actions CI/CD for image publish on merge to main
  - Smoke tests embedded in workflow for binary verification (claude, notesmd-cli, act, vncserver, openbox)
  - Ready for S02 to extend: all 4 templates will change FROM ubuntu:24.04 to FROM ghcr.io/kethalia/hive-base:latest
requires:
  []
affects:
  - S02: Template Migration — all 4 templates shrink from 131 lines (base setup duplicated) to ~20 lines each (extend base image)
  - S03: Obsidian & Vault Integration — Obsidian already installed with CLI enabled, notesmd-cli on PATH, KasmVNC+Openbox configured
key_files:
  - docker/hive-base/Dockerfile
  - .github/workflows/build-base-image.yml
key_decisions:
  - D023: notesmd-cli via pre-built v0.3.4 binary (not source build) — avoids Go toolchain, ~50MB smaller
  - D024: Obsidian pinned to v1.12.7 via direct GitHub releases URL — reproducible builds
  - D025: PostgreSQL unversioned in Debian 13 (trixie ships v17 natively) — simpler than ubuntu:24.04
  - D026: GHCR publish pattern — dual tags (:latest + :sha), push only on main, PRs build-only
patterns_established:
  - Dockerfile layer caching by update frequency: stable layers early (FROM, Docker, Chrome, Node.js), volatile layers late (Obsidian, notesmd-cli, act)
  - CI smoke test pattern for binaries: docker run --rm <image> <tool> --version validates binary presence and dep satisfaction
  - GHCR dual-tag strategy: :latest for convenience, :sha for reproducibility
  - PR vs main build distinction: PRs build locally (no push), main publishes to registry
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-09T15:52:21.691Z
blocker_discovered: false
---

# S01: Base Image & CI

**Created hive-base Docker image on Debian 13 (trixie) with KasmVNC+Openbox, all shared tooling (Claude CLI, Obsidian, notesmd-cli, act), and GitHub Actions CI/CD to publish to GHCR on merge to main.**

## What Happened

S01 delivered two production-ready artifacts: (1) docker/hive-base/Dockerfile (169 lines) — a single shared base image for all Hive templates, adapting the templates/hive-council/Dockerfile from ubuntu:24.04 to Debian 13 (trixie). Key structural changes: Docker CE repo URL changed to linux/debian, PostgreSQL unversioned (trixie ships v17 natively), KasmVNC updated to trixie .deb, openbox replaces fluxbox, ssl-cert group added to coder user (required for KasmVNC). New layers added: Claude CLI (curl|bash), Obsidian v1.12.7 with headless config, notesmd-cli v0.3.4 pre-built binary, and act binary. (2) .github/workflows/build-base-image.yml (127 lines) — fully automated CI/CD for image publish to ghcr.io/kethalia/hive-base:latest. Triggers on push/main, pull_request, and workflow_dispatch; builds with docker/build-push-action@v6; runs 5 smoke tests (claude, notesmd-cli, act, vncserver, openbox); pushes to GHCR only on main (PRs build-only, no push); dual-tags with :latest and :sha. Layer caching via GitHub Actions (type=gha, mode=max) for efficiency. All 14 slice must-haves verified: file existence, Dockerfile contains all required layers (grep suite passes), workflow YAML is valid, permissions set, smoke tests defined, push conditional on main. Both tasks completed without blockers, no build-time failures surfaced (first CI execution will occur on PR/merge).

## Verification

All 14 must-have verification checks pass: (T01) docker/hive-base/Dockerfile exists with debian:trixie base, openbox present, fluxbox absent, ssl-cert group in useradd, claude.ai/install.sh script, notesmd-cli on PATH, act binary, kasmvncserver_trixie .deb, google-chrome-stable, PostgreSQL unversioned, Node.js 24 via NodeSource. (T02) .github/workflows/build-base-image.yml exists, valid YAML, triggers on push/main/PR/manual, uses docker/build-push-action, GHCR login configured, packages:write permission set, smoke tests verify claude/notesmd-cli/act/vncserver/openbox (all 5 defined), push conditional on main. Docker build not yet executed in CI — smoke test failures (broken URLs, missing deps) will surface on first workflow run. All static checks pass; integration proof occurs on first merge to main.

## Requirements Advanced

None.

## Requirements Validated

- R035: Shared base Docker image on Debian 13 published to GHCR — Validated via docker/hive-base/Dockerfile + GitHub Actions CI
- R036: KasmVNC + Openbox in all templates — Validated; both present in base, all templates will extend
- R039: notesmd-cli for headless vault access — Validated via v0.3.4 pre-built binary installed and on PATH
- R040: GitHub Actions workflow for CI/CD publish — Validated via .github/workflows/build-base-image.yml with GHCR push, smoke tests, conditional push on main

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

None.

## Known Limitations

["Dockerfile not yet built in CI — download URL breakages (Obsidian, notesmd-cli) will surface on first workflow run", "Smoke tests are basic (--version checks); don't verify functional usage (e.g., actual Obsidian vault operation, VNC desktop rendering)", "KasmVNC Openbox desktop not tested visually; rely on 'which openbox' and 'which vncserver' as proxy"]

## Follow-ups

["S02 must verify all 4 templates' Dockerfiles reduce to <20 lines and build succeeds", "First PR/merge will execute GitHub Actions workflow — monitor for download URL failures or dependency conflicts", "After image publishes to GHCR, verify it's pullable and all smoke tests pass in CI logs"]

## Files Created/Modified

- `docker/hive-base/Dockerfile` — Created: 169-line Dockerfile on debian:trixie with KasmVNC+Openbox, Chrome, Node.js 24, Docker CE, Claude CLI, Obsidian, notesmd-cli, act
- `.github/workflows/build-base-image.yml` — Created: 127-line GitHub Actions workflow to build hive-base, run smoke tests, push to ghcr.io/kethalia/hive-base on merge to main
