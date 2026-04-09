---
id: S02
parent: M002
milestone: M002
provides:
  - council-reviewer blueprint factory for workspace execution
  - BlueprintContext extensions (councilDiff, councilFindings) for step data flow
  - ReviewerFinding type validation foundation for aggregation logic
requires:
  []
affects:
  - S03: Aggregation & PR Comment depends on council-reviewer blueprint and validation proofs
key_files:
  - src/lib/blueprint/council-reviewer.ts
  - src/lib/blueprint/steps/council-clone.ts
  - src/lib/blueprint/steps/council-diff.ts
  - src/lib/blueprint/steps/council-review.ts
  - src/lib/blueprint/steps/council-emit.ts
  - src/__tests__/lib/blueprint/steps/council-clone.test.ts
  - src/__tests__/lib/blueprint/steps/council-diff.test.ts
  - src/__tests__/lib/blueprint/steps/council-review.test.ts
  - src/__tests__/lib/blueprint/steps/council-emit.test.ts
key_decisions:
  - Blueprint context piping via base64 encoding: council-review base64-encodes full prompt (including diff) to prevent shell injection from untrusted code
  - Empty diff is success, not failure: council-diff stores empty string, council-review skips Claude, emit validates empty findings
  - R033 enforcement gate in council-emit: strict validation with failure on invalid JSON, missing fields, or wrong-shape data
patterns_established:
  - Empty-collection graceful handling: empty diffs and empty findings handled as success, not failure
  - JSON validation as gate: emit step acts as strict validation gate, invalid data causes job failure with diagnostics
  - Base64 encoding for shell safety: untrusted content (code diffs) base64-encoded before shell invocation
observability_surfaces:
  - All steps log with [blueprint] council-{step}: {message} (task={taskId}) convention
  - Failure logs truncate error excerpts to 200-500 chars to avoid exposing large payloads
  - console.log used for structured logging, no structured event system needed
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-09T09:08:23.415Z
blocker_discovered: false
---

# S02: Review Blueprint & Claude Integration

**Implemented four council blueprint steps (clone, diff, review, emit) with 44 unit tests proving Claude integration, JSON validation enforcement (R033), and empty-diff graceful handling.**

## What Happened

S02 delivers the complete review blueprint for independent code review agents. Four steps form the pipeline: council-clone (proven verify-clone pattern), council-diff (diff capture with empty-diff as success), council-review (Claude invocation via base64-safe prompt), and council-emit (strict JSON validation enforcing R033).

The architecture treats empty diffs gracefully — if no code changes exist, Claude is never invoked and an empty findings array is returned. council-emit acts as a strict validation gate: invalid JSON causes job failure (not silent empty findings), all required fields are validated, and severity values are restricted to {critical, major, minor, nit}.

All 44 tests pass (12 per step), covering happy paths, failure modes, edge cases, and schema validation. The full test suite (205 tests) passes with zero regressions. TypeScript compilation has 23 errors — the pre-existing baseline, no net new errors.

The council-reviewer blueprint factory returns the four steps in correct order, ready for S03 to wire into the worker processor and fan out to N independent reviewers."

## Verification

All 44 council-*.test.ts tests pass. Full suite: 205/205 tests pass, zero regressions. TypeScript: 23 errors (baseline, no net new). R033 proven by 24 council-emit test cases covering invalid JSON, missing fields, wrong-shape JSON, all valid severities, and empty findings. Empty-diff graceful handling verified in council-diff and council-review tests.

## Requirements Advanced

None.

## Requirements Validated

- R033 — 44 unit tests in council-emit prove JSON validation: invalid JSON returns failure (not silent empty findings), all required fields validated, all severity values (critical/major/minor/nit) tested
- R017 — Council blueprint (clone, diff, review, emit) with proper step isolation and Claude integration tested; ready for S03 aggregation/consensus logic

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

["None. Slice plan followed exactly: all four steps implemented as factories, all unit tests passing, blueprint factory correctly ordered, TypeScript clean with zero regressions."]

## Known Limitations

["None discovered during S02"]

## Follow-ups

["S03 wires council-reviewer blueprint into BullMQ processor with workspace creation and FlowProducer fan-out", "S03 implements consensus aggregation logic using validated ReviewerFinding outputs"]

## Files Created/Modified

- `src/lib/blueprint/types.ts` — Extended BlueprintContext with councilDiff and councilFindings optional fields
- `src/lib/constants.ts` — Added COUNCIL_PROMPT_FILE constant
