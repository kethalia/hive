---
id: T01
parent: S01
milestone: M004
key_files:
  - src/lib/coder/client.ts
  - src/lib/coder/types.ts
key_decisions:
  - (none)
duration: 
verification_result: passed
completed_at: 2026-04-13T18:27:10.285Z
blocker_discovered: false
---

# T01: Added listTemplates, getTemplateVersion, and fetchTemplateFiles methods to CoderClient

**Added listTemplates, getTemplateVersion, and fetchTemplateFiles methods to CoderClient**

## What Happened

Extended src/lib/coder/client.ts with three new methods for template operations: listTemplates() fetches all templates from the default org, getTemplateVersion() retrieves version metadata including the file ID, and fetchTemplateFiles() downloads the tar archive as a Buffer. Added corresponding CoderTemplate and CoderTemplateVersion types to types.ts. All methods follow the existing authenticated request pattern.

## Verification

npx vitest run src/__tests__/lib/coder/client.test.ts — 15 tests pass

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/coder/client.test.ts` | 0 | pass | 297ms |

## Deviations

Method named getTemplateVersion instead of getActiveVersion — more general since it works with any version ID, not just active ones.

## Known Issues

None.

## Files Created/Modified

- `src/lib/coder/client.ts`
- `src/lib/coder/types.ts`
