---
id: S01
parent: M004
milestone: M004
provides:
  - ["compareTemplates() function returning per-template stale/current status", "CoderClient template API methods (listTemplates, getTemplateVersion, fetchTemplateFiles)", "TemplateStatus type export"]
requires:
  []
affects:
  []
key_files:
  - ["src/lib/coder/client.ts", "src/lib/coder/types.ts", "src/lib/templates/staleness.ts", "src/__tests__/lib/templates/staleness.test.ts"]
key_decisions:
  - (none)
patterns_established:
  - ["Deterministic hashing via sorted path+content sha256 for both local filesystem and remote tar archives", "Graceful degradation pattern: return safe default (stale=false) on network errors to prevent spurious actions during outages", "tar-stream package for parsing Coder file archives"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-13T23:04:46.358Z
blocker_discovered: false
---

# S01: Coder Template API Client & Staleness Engine

**Extended CoderClient with template listing/version/file-fetching methods and built a deterministic staleness engine that compares local template files against Coder's active version via sha256 hashing.**

## What Happened

## T01: Coder Client Extension

Extended `src/lib/coder/client.ts` with three new methods following the existing authenticated request pattern:
- `listTemplates()` — fetches all templates from the default org via `GET /api/v2/organizations/default/templates`
- `getTemplateVersion(versionId)` — retrieves version metadata including the fileId (named `getTemplateVersion` instead of plan's `getActiveVersion` for generality)
- `fetchTemplateFiles(fileId)` — downloads the tar archive as a Buffer via `GET /api/v2/files/:id`

Added `CoderTemplate` and `CoderTemplateVersion` types to `src/lib/coder/types.ts`. 15 client tests pass.

## T02: Staleness Engine

Created `src/lib/templates/staleness.ts` with three exported functions:
- `hashLocalTemplate(name)` — recursively reads files under `templates/<name>/`, excludes `.terraform`, sorts paths deterministically, and produces a sha256 hex digest of path+contents
- `hashRemoteTar(tarBuffer)` — parses tar buffer via `tar-stream`, sorts entries by path, and hashes identically to local
- `compareTemplates(names)` — orchestrates both hashing approaches, fetches remote state via CoderClient, returns `{name, stale, lastPushed, activeVersionId, localHash, remoteHash}[]`

Key design choice: graceful degradation — returns `stale=false` (not an error) when Coder is unreachable, preventing spurious pushes during outages.

## T03: Unit Tests

Created comprehensive test suite with 13 tests across three describe blocks:
- **hashLocalTemplate**: stability across calls, change detection, `.terraform` exclusion, missing directory error handling
- **hashRemoteTar**: stability, change detection, order-independence (deterministic sort)
- **compareTemplates**: stale detection (true/false), templates not in remote, multi-template handling, env var validation, graceful fallback on network errors

Uses real filesystem (temp dirs) for local hash tests and a `createTarBuffer` helper for tar generation. Full project suite: 295 tests across 39 files, zero failures.

## Verification

**Staleness tests:** `pnpm vitest run src/__tests__/lib/templates/staleness.test.ts` — 13 tests pass (18ms)
**Client tests:** `pnpm vitest run src/__tests__/lib/coder/client.test.ts` — 15 tests pass (91ms)
**Full suite:** `pnpm vitest run` — 295 tests across 39 files, zero failures (2.19s)

All slice plan verification criteria met:
- Hash stability verified (same result on repeated calls)
- Stale detection verified (true when hashes differ, false when they match)
- compareTemplates returns correct shape with all required fields
- No regressions introduced in existing test suite

## Requirements Advanced

None.

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Method named getTemplateVersion instead of getActiveVersion (plan said getActiveVersion) — more general since it works with any version ID, not just active ones.

## Known Limitations

compareTemplates returns stale=false on network errors, meaning genuinely stale templates won't be detected during Coder outages. Downstream consumers should treat stale=false as 'current OR unknown'.

## Follow-ups

S02 (Push Job Worker & SSE Streaming Route) depends on compareTemplates() and CoderClient template methods from this slice. S03 (Templates Dashboard Page) depends on both S01 and S02.

## Files Created/Modified

- `src/lib/coder/client.ts` — Added listTemplates, getTemplateVersion, fetchTemplateFiles methods
- `src/lib/coder/types.ts` — Added CoderTemplate and CoderTemplateVersion types
- `src/lib/templates/staleness.ts` — New file: hashLocalTemplate, hashRemoteTar, compareTemplates functions
- `src/__tests__/lib/templates/staleness.test.ts` — New file: 13 unit tests for staleness engine
