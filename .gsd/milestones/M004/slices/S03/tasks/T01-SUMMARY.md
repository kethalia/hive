---
id: T01
parent: S03
milestone: M004
key_files:
  - src/app/templates/actions.ts
  - src/__tests__/app/api/templates/status.test.ts
  - src/app/api/templates/status/route.ts
key_decisions:
  - Used KNOWN_TEMPLATES (2 templates) rather than the plan's mention of 4 — matched actual codebase reality
duration: 
verification_result: passed
completed_at: 2026-04-13T23:16:00.650Z
blocker_discovered: false
---

# T01: Add server action getTemplateStatuses() and GET /api/templates/status route with tests

**Add server action getTemplateStatuses() and GET /api/templates/status route with tests**

## What Happened

Created `src/app/templates/actions.ts` with two server actions: `getTemplateStatuses()` which calls `compareTemplates()` for all entries in `KNOWN_TEMPLATES` (currently "hive" and "ai-dev"), and `revalidateTemplates()` which calls `revalidatePath("/templates")` for cache busting after a successful push.

The GET `/api/templates/status` route already existed from prior slice work (S02) and was complete — it returns a JSON array of `TemplateStatus` objects by calling `compareTemplates([...KNOWN_TEMPLATES])`.

Created `src/__tests__/app/api/templates/status.test.ts` with 3 tests covering: successful status fetch, 500 error when compareTemplates throws, and verification that all known template names are passed through. The plan referenced "4 known templates" but the actual `KNOWN_TEMPLATES` array contains 2 (`hive`, `ai-dev`) — tests match reality.

## Verification

Ran `npx vitest run src/__tests__/app/api/templates/status.test.ts` — 3 tests passed. Ran full suite `npx vitest run` — 315 tests passed (42 files), no regressions.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/app/api/templates/status.test.ts` | 0 | ✅ pass | 175ms |
| 2 | `npx vitest run` | 0 | ✅ pass (315 tests, 42 files) | 2180ms |

## Deviations

The plan said "all 4 known template names" but KNOWN_TEMPLATES only contains 2 (hive, ai-dev). Implementation uses the actual array. The status route already existed from S02 work and needed no changes.

## Known Issues

None

## Files Created/Modified

- `src/app/templates/actions.ts`
- `src/__tests__/app/api/templates/status.test.ts`
- `src/app/api/templates/status/route.ts`
