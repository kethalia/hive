---
id: T03
parent: S01
milestone: M006
key_files:
  - services/terminal-proxy/test/keepalive-integration.test.ts
  - src/__tests__/components/keep-alive-warning.test.tsx
key_decisions:
  - Placed integration tests in test/ directory (matching terminal-proxy's vitest config include pattern) rather than src/__tests__/
  - Used real HTTP servers for integration tests instead of mocking fetch — validates actual network behavior including timeout handling
duration: 
verification_result: passed
completed_at: 2026-04-15T14:34:46.502Z
blocker_discovered: false
---

# T03: Add integration tests for KeepAliveManager with real HTTP mock server and component tests for KeepAliveWarning rendering thresholds

**Add integration tests for KeepAliveManager with real HTTP mock server and component tests for KeepAliveWarning rendering thresholds**

## What Happened

Created two test files covering the complete keep-alive flow:

1. **Integration tests** (`services/terminal-proxy/test/keepalive-integration.test.ts`) — 12 tests that spin up a real HTTP server simulating Coder's extend endpoint. Tests verify: ping hits the correct URL with auth headers, valid deadline in request body, failure counter increments on 500/401 errors, counter resets on recovery after failures, no pings when zero connections exist, network timeout handling, accumulation of exactly 3 failures (banner threshold), and session token not leaked in health output. Also tests the `/keepalive/status` endpoint response shape with empty and populated workspace health.

2. **Component tests** (`src/__tests__/components/keep-alive-warning.test.tsx`) — 7 tests verifying KeepAliveWarning renders nothing at 0, 1, 2 failures; renders destructive Alert at 3+ failures with correct count; passes workspaceId to the hook; and mentions auto-stop in the description.

All 68 terminal-proxy tests pass (including 21 existing unit tests + 23 proxy tests + 12 protocol tests + 12 new integration tests). All 7 component tests pass.

## Verification

- `cd services/terminal-proxy && pnpm vitest run` — 68 tests pass (4 test files), including 12 new integration tests
- `pnpm vitest run src/__tests__/components/keep-alive-warning.test.tsx` — 7 tests pass
- `pnpm tsc --noEmit` — no keep-alive related TS errors (pre-existing errors in council-queues.ts and task-queue.ts are unrelated)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd services/terminal-proxy && pnpm vitest run` | 0 | ✅ pass | 10250ms |
| 2 | `pnpm vitest run src/__tests__/components/keep-alive-warning.test.tsx` | 0 | ✅ pass | 611ms |
| 3 | `pnpm tsc --noEmit | grep keepalive` | 0 | ✅ pass (no keep-alive errors; pre-existing errors in council-queues.ts/task-queue.ts unrelated) | 5000ms |

## Deviations

Task plan specified `services/terminal-proxy/src/__tests__/keepalive-integration.test.ts` and `src/components/workspaces/__tests__/KeepAliveWarning.test.tsx` as output paths. Actual paths are `services/terminal-proxy/test/keepalive-integration.test.ts` (matching the vitest config's `test/**/*.test.ts` include pattern) and `src/__tests__/components/keep-alive-warning.test.tsx` (matching the root vitest config's `src/__tests__/**/*.test.tsx` pattern).

## Known Issues

Pre-existing TypeScript errors in src/lib/queue/council-queues.ts and src/lib/queue/task-queue.ts (ioredis version mismatch) cause `pnpm tsc --noEmit` to exit non-zero. These are unrelated to keep-alive work.

## Files Created/Modified

- `services/terminal-proxy/test/keepalive-integration.test.ts`
- `src/__tests__/components/keep-alive-warning.test.tsx`
