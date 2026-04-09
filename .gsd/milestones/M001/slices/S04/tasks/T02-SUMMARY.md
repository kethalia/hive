---
id: T02
parent: S04
milestone: M001
provides:
  - createCIStep factory — composite CI feedback step with 2-round retry cap, polling, and failure log extraction
key_files:
  - src/lib/blueprint/steps/ci.ts
  - src/__tests__/lib/blueprint/steps/ci.test.ts
  - src/lib/blueprint/types.ts
key_decisions:
  - Injected step dependencies (agent, lint, commit-push) via factory functions to avoid circular imports and enable clean mocking
  - CI failure logs augmented into prompt text (not assembledContext) so the agent sees them as the primary instruction
patterns_established:
  - Composite steps orchestrate sub-steps via injected factories, keeping each step independently testable
  - vi.useFakeTimers + advanceTimersByTimeAsync for testing code with sleep/setTimeout loops without real delays
observability_surfaces:
  - "[blueprint] ci-feedback:" logs at each phase — auth check, round start, poll status, retry trigger, exhaustion
  - ctx.ciRoundsUsed set after each round for downstream visibility
duration: 12m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T02: Build CI feedback composite step with 2-round retry cap

**Implemented CI feedback composite step with GitHub Actions polling, failure log extraction, agent retry, and 2-round cap (R029)**

## What Happened

Built `createCIStep(deps)` — a composite blueprint step that orchestrates CI verification after a push:

1. **Auth check**: Verifies `gh auth status` before any polling. Returns failure immediately if not authenticated.
2. **Polling**: Uses `gh run list --branch <branch> --limit 1 --json status,conclusion,databaseId` with exponential backoff (5s → 10s → 20s → 30s cap) and a 10-minute total timeout per round. Initial 10s delay lets GitHub Actions register the run.
3. **Failure extraction**: On CI failure, extracts logs via `gh run view <id> --log-failed`, truncated to 3000 chars.
4. **Retry (round 2)**: Feeds failure logs into the agent's prompt, re-runs agent → lint → commit-push, then polls again.
5. **Exhaustion**: If round 2 also fails, returns failure with "CI failed after 2 rounds" and includes truncated failure summary.

Dependencies (agent/lint/commit-push step factories) are injected via the `deps` parameter — this avoids circular imports and makes testing straightforward with mock steps.

Also added `ciRoundsUsed?: number` and `prUrl?: string` to `BlueprintContext` for downstream visibility and PR URL persistence.

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts` — 5 tests pass (first-round success, retry success, exhaustion, auth failure, delayed run discovery)
- `npx vitest run` — 71 tests pass, zero regressions

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts` | 0 | ✅ pass | 3.4s |
| 2 | `npx vitest run` | 0 | ✅ pass | 3.7s |

## Diagnostics

- Grep for `[blueprint] ci-feedback:` in container logs to trace CI round progression per task
- `ctx.ciRoundsUsed` is set after each round — worker can persist this to `taskLogs` for inspection
- Failure messages include round count and truncated CI error logs for debugging
- Auth failures are caught early with a descriptive message before any polling begins

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/lib/blueprint/types.ts` — Added `ciRoundsUsed?: number` and `prUrl?: string` to BlueprintContext
- `src/lib/blueprint/steps/ci.ts` — CI feedback composite step: auth check, polling with backoff, failure log extraction, agent retry, 2-round cap
- `src/__tests__/lib/blueprint/steps/ci.test.ts` — 5 tests: CI passes round 1, retry succeeds round 2, exhaustion after 2 failures, gh auth failure, delayed run discovery
