---
id: T03
parent: S01
milestone: M005
key_files:
  - src/__tests__/lib/workspaces/urls.test.ts
  - src/__tests__/lib/workspaces/sessions.test.ts
  - src/__tests__/lib/workspaces/actions.test.ts
key_decisions:
  - Mocked safe-action's actionClient inline to avoid importing the real next-safe-action module which depends on server-only context; used dynamic imports with vi.resetModules() to get fresh action instances per test
duration: 
verification_result: passed
completed_at: 2026-04-14T10:55:49.679Z
blocker_discovered: false
---

# T03: Add unit tests for workspace URL builder, tmux session parser, and server actions

**Add unit tests for workspace URL builder, tmux session parser, and server actions**

## What Happened

Created three test files covering the workspace data layer introduced in T01:

1. **urls.test.ts** (5 tests) — Tests `buildWorkspaceUrls` for standard inputs, trailing slash stripping, path prefix handling, and agent name substitution in filebrowser/kasmvnc/dashboard URLs.

2. **sessions.test.ts** (7 tests) — Tests `parseTmuxSessions` for single line, multiple lines, empty input, whitespace-only input, malformed lines (missing fields, non-numeric values), and trailing newline handling.

3. **actions.test.ts** (4 tests) — Tests server actions with mocked CoderClient and execInWorkspace. Covers `listWorkspacesAction` happy path, `getWorkspaceSessionsAction` with parsed tmux output, empty array when no agents found (catch path), and empty array when tmux exits non-zero.

All tests follow the existing vitest pattern from `client.test.ts` — using `vi.fn()`, `vi.mock()`, `vi.stubEnv()`, and `vi.spyOn(console)` for clean isolation. The actions test uses `vi.resetModules()` with dynamic imports to get fresh module instances per test since the server actions capture the mock at module load time.

## Verification

Ran `pnpm vitest run src/__tests__/lib/workspaces/` — all 16 tests pass (3 files). Ran `pnpm vitest run` — all 331 tests pass across 45 files with no regressions.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/workspaces/` | 0 | ✅ pass | 190ms |
| 2 | `pnpm vitest run` | 0 | ✅ pass | 2700ms |

## Deviations

none

## Known Issues

none

## Files Created/Modified

- `src/__tests__/lib/workspaces/urls.test.ts`
- `src/__tests__/lib/workspaces/sessions.test.ts`
- `src/__tests__/lib/workspaces/actions.test.ts`
