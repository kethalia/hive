---
id: T02
parent: S01
milestone: M004
key_files:
  - src/lib/templates/staleness.ts
key_decisions:
  - (none)
duration: 
verification_result: passed
completed_at: 2026-04-13T18:27:16.091Z
blocker_discovered: false
---

# T02: Implemented staleness engine with hashLocalTemplate, hashRemoteTar, and compareTemplates

**Implemented staleness engine with hashLocalTemplate, hashRemoteTar, and compareTemplates**

## What Happened

Created src/lib/templates/staleness.ts with three exported functions. hashLocalTemplate recursively reads template files (excluding .terraform), sorts paths deterministically, and produces a sha256 digest. hashRemoteTar parses a tar buffer via tar-stream, sorts entries, and hashes identically. compareTemplates orchestrates both — fetches remote state via CoderClient, computes both hashes, and returns per-template stale/current status. Graceful degradation: returns stale=false when Coder is unreachable or individual templates fail, to avoid spurious pushes during outages.

## Verification

npx vitest run src/__tests__/lib/templates/staleness.test.ts — 13 tests pass

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/templates/staleness.test.ts` | 0 | pass | 183ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/lib/templates/staleness.ts`
