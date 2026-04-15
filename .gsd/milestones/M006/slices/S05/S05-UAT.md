# S05: End-to-End Integration & Regression — UAT

**Milestone:** M006
**Written:** 2026-04-15T18:00:36.113Z

# S05 UAT: End-to-End Integration & Regression

## Preconditions
- Repository checked out at the S05 completion commit
- Node.js and pnpm available
- No live Postgres or WebSocket server required (all tests use mocks)

## Test Case 1: Cross-Slice Data Flow Tests Pass
**Steps:**
1. Run `pnpm vitest run src/__tests__/integration/terminal-data-flow.test.ts`
**Expected:** 12 tests pass covering hydration gating (3), format compatibility (4), reconnectId lifecycle (5)

## Test Case 2: InteractiveTerminal Integration Tests Pass
**Steps:**
1. Run `pnpm vitest run src/__tests__/integration/interactive-terminal-integration.test.tsx`
**Expected:** 10 tests pass covering hydration banners (3), connection state banners (3), history panel and scroll UX (4)

## Test Case 3: TerminalTabManager Regression Tests Pass
**Steps:**
1. Run `pnpm vitest run src/__tests__/integration/terminal-tab-manager-regression.test.tsx`
**Expected:** 8 tests pass covering session CRUD (4), tab switching (1), KeepAliveWarning (2), reconnectId cleanup (1)

## Test Case 4: Full Frontend Suite — Zero Regressions
**Steps:**
1. Run `pnpm vitest run`
**Expected:** 63 test files, 504 tests pass, 0 failures. Count must be >= 504 (no regressions from S04's 474 baseline).

## Test Case 5: Terminal-Proxy Suite Unaffected
**Steps:**
1. Run `cd services/terminal-proxy && pnpm vitest run`
**Expected:** 88+ tests pass across 6 files. S05 made no proxy changes — this confirms no cross-boundary regressions.

## Test Case 6: TypeScript Clean
**Steps:**
1. Run `pnpm tsc --noEmit`
**Expected:** Exit code 0 or only pre-existing errors (ioredis version conflicts, Prisma types). No new TypeScript errors from S05 files.

## Edge Cases
- **Hydration error path:** T01 tests verify that when hydration fails, gating is still released and buffered WebSocket data flushes (not silently dropped)
- **Empty scrollback response:** T01 tests verify Content-Length: 0 responses are handled gracefully
- **Debounced scroll events:** T02 tests wait 150ms past the 100ms debounce to verify scroll-driven state changes
- **Multi-tab reconnectId isolation:** T03 tests verify killing one tab's session only cleans up that session's localStorage entry, not other sessions'
