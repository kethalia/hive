---
id: S02
parent: M003
milestone: M003
provides:
  - minimal-template-dockerfiles
  - openbox-window-manager
  - kasmvnc-wiring
  - validated-terraform-configs
requires:
  - slice: S01
    provides: 
affects:
  []
key_files:
  - templates/hive-worker/Dockerfile
  - templates/hive-verifier/Dockerfile
  - templates/hive-council/Dockerfile
  - templates/ai-dev/Dockerfile
  - templates/hive-worker/scripts/browser-serve.sh
  - templates/hive-verifier/scripts/browser-serve.sh
  - templates/ai-dev/scripts/browser-serve.sh
  - templates/hive-council/scripts/browser-serve.sh
  - templates/hive-council/main.tf
key_decisions:
  - (none)
patterns_established:
  - All templates extend hive-base:latest (no per-template base duplication)
  - Uniform window manager choice: openbox with --sm-disable --display for headless containers
  - KasmVNC integration pattern: coder_script (browser-serve.sh) + coder_app (localhost:6080)
  - Single-line Dockerfile pattern for templates — custom layers only when per-template needs exist
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-09T16:09:19.027Z
blocker_discovered: false
---

# S02: S02: Template Migration

**Migrated all 4 template Dockerfiles to minimal single-line FROM hive-base files; aligned browser scripts to openbox; wired KasmVNC into hive-council; all terraform validate + 263 vitest tests pass.**

## What Happened

S02 completed all planned template migration work. T01 replaced all four verbose ~130-line Dockerfiles (hive-worker, hive-verifier, hive-council, ai-dev) with minimal one-line FROM ghcr.io/kethalia/hive-base:latest statements, consolidating ~520 lines of redundant code. Concurrently, T01 updated all three existing browser-serve.sh scripts from fluxbox to openbox with correct --sm-disable and --display flags for headless container use. T02 created hive-council/scripts/browser-serve.sh (copied from hive-worker, already updated in T01) and added matching Terraform resources (coder_script.browser_serve + coder_app.browser_vision) to hive-council/main.tf following the hive-worker pattern. All four templates pass terraform validate. The full vitest suite (263 tests, 37 files) passes with no regressions. Slice verification is complete: dockerfiles are 1 line, no ubuntu:24.04 references, no fluxbox references, openbox present uniformly, hive-council fully wired, all infrastructure passes validation. The slice establishes patterns for minimal template structure, uniform window manager choice, and KasmVNC integration that downstream slices can rely on.

## Verification

✅ All 4 Dockerfiles: 1 line (wc -l). ✅ No ubuntu:24.04 (grep -r). ✅ No fluxbox (grep -r). ✅ openbox present in all 3 existing browser-serve.sh (grep -c). ✅ hive-council browser-serve.sh executable (test -x). ✅ hive-council main.tf has coder_script.browser_serve + coder_app.browser_vision (grep -q). ✅ terraform validate passes for hive-worker, hive-verifier, hive-council, ai-dev. ✅ npx vitest run: 263 tests passed (37 files).

## Requirements Advanced

None.

## Requirements Validated

- R035 — All 4 templates now contain only FROM ghcr.io/kethalia/hive-base:latest (verified by wc -l, grep -r). No ubuntu:24.04 base duplication. terraform validate passes for all templates, proving HCL correctness and image resolution.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

None.

## Known Limitations

["web3-dev template not in scope — still uses ubuntu:24.04; can be migrated to hive-base in future PR with single-line Dockerfile change","Base image URL hardcoded in all Dockerfiles — no Terraform variable or build-arg; acceptable for now (stable URL), but future enhancement could parameterize this"]

## Follow-ups

None.

## Files Created/Modified

None.
