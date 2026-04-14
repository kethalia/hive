---
id: T01
parent: S03
milestone: M005
key_files:
  - src/lib/actions/workspaces.ts
  - src/__tests__/lib/actions/session-actions.test.ts
key_decisions:
  - Auto-naming uses timestamp-based pattern (session-<Date.now()>) rather than counter or cwd-based naming — simpler, collision-free, no state tracking needed
duration: 
verification_result: passed
completed_at: 2026-04-14T11:27:34.951Z
blocker_discovered: false
---

# T01: Add createSessionAction, renameSessionAction, and killSessionAction server actions with SAFE_IDENTIFIER_RE validation and 14 unit tests

**Add createSessionAction, renameSessionAction, and killSessionAction server actions with SAFE_IDENTIFIER_RE validation and 14 unit tests**

## What Happened

Added three new server actions to `src/lib/actions/workspaces.ts` following the established `getWorkspaceSessionsAction` pattern:

1. **createSessionAction** — Creates a new tmux session via `tmux new-session -d -s <name>`. Accepts optional `sessionName`; defaults to `session-<timestamp>` for auto-naming. Validates name against `SAFE_IDENTIFIER_RE` before execution.

2. **renameSessionAction** — Renames an existing tmux session via `tmux rename-session -t <old> <new>`. Validates both old and new names against `SAFE_IDENTIFIER_RE`.

3. **killSessionAction** — Kills a tmux session via `tmux kill-session -t <name>`. Validates name against `SAFE_IDENTIFIER_RE`.

All three actions resolve the workspace agent via `client.getWorkspaceAgentName()`, execute commands via `execInWorkspace()`, and throw descriptive errors on non-zero exit codes. Console logging follows the existing `[workspaces]` prefix pattern.

Created 14 unit tests in `src/__tests__/lib/actions/session-actions.test.ts` covering: happy path execution with correct tmux commands, auto-generated session names, SAFE_IDENTIFIER_RE rejection for shell-injection attempts, tmux command failure propagation, and missing agent error handling.

## Verification

Ran targeted test file: `pnpm vitest run src/__tests__/lib/actions/session-actions.test.ts` — 14/14 passed. Ran full suite: `pnpm vitest run` — 389/389 tests passed across 49 test files, no regressions.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/actions/session-actions.test.ts` | 0 | ✅ pass | 203ms |
| 2 | `pnpm vitest run` | 0 | ✅ pass | 2370ms |

## Deviations

Auto-naming uses `session-<Date.now()>` instead of the plan's `session-1` counter pattern. A counter would require querying existing sessions first to determine the next number, adding complexity and a race condition. Timestamp is simpler and collision-free.

## Known Issues

none

## Files Created/Modified

- `src/lib/actions/workspaces.ts`
- `src/__tests__/lib/actions/session-actions.test.ts`
