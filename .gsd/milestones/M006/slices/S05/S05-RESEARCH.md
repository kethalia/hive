# S05 — End-to-End Integration & Regression — Research

**Date:** 2026-04-15
**Depth:** Light research — this slice is straightforward verification of known, working subsystems (S01–S04) using established test patterns already in the codebase.

## Summary

S05 is a verification and regression slice, not a feature slice. All four dependency slices (S01–S04) are complete with 474 tests passing across 60 files. The work is: (1) write cross-slice integration tests that prove the components work together end-to-end, and (2) confirm no regressions in pre-existing terminal features (session CRUD, tab switching, rename, kill).

There is no e2e test framework (Playwright/Cypress) in the repo, and adding one is out of scope for a "low risk" integration slice. The right approach is **vitest integration tests** that exercise cross-component wiring and cross-service data flow, using the same patterns established in S01–S04. The existing `scrollback-integration.test.ts` (skipped without DATABASE_URL) and `keepalive-integration.test.ts` patterns show how to write these.

## Recommendation

Write vitest-based integration tests covering three areas:

1. **Cross-slice data flow tests** — Prove the full pipeline: ScrollbackWriter → Postgres → scrollback API route → hydration hook → xterm.write(). Mock Postgres at the boundary (Prisma for reads, postgres pool for writes) to test the integration logic without requiring a live database.

2. **Component integration tests** — Verify InteractiveTerminal correctly wires hydration, reconnection, history panel, and jump-to-bottom together. Test that hydration gates live data, that reconnectId regeneration triggers re-hydration, and that the history panel appears on scroll-to-top.

3. **Regression tests for pre-existing features** — Confirm session create/rename/kill, tab switching with display:none preservation, connection badge states, and KeepAliveWarning still work in the presence of the new M006 features (hydration, history panel, etc.).

## Implementation Landscape

### Key Files

- `src/components/workspaces/InteractiveTerminal.tsx` — The integration hub: wires useScrollbackHydration, useTerminalWebSocket, TerminalHistoryPanel, JumpToBottom, ResizeObserver, reconnectId lifecycle. Most integration tests target this component.
- `src/components/workspaces/TerminalTabManager.tsx` — Multi-tab orchestration: session auto-load, tab CRUD, connection state tracking, KeepAliveWarning mounting. Regression tests target this.
- `src/hooks/useTerminalWebSocket.ts` — Exports: send, resize, connectionState, reconnectAttempt, consecutiveFailures, reconnect, flushBufferedData. The isGatingLiveData prop is the key integration point with hydration.
- `src/hooks/useScrollbackHydration.ts` — Returns hydrationState and isGatingLiveData. Integrates with terminal ref and connection state.
- `src/hooks/useScrollbackPagination.ts` — Cursor-based backward pagination for history panel.
- `src/app/api/terminal/scrollback/route.ts` — Dual-mode API: binary for hydration, JSON for pagination. Both paths need integration coverage.
- `services/terminal-proxy/src/proxy.ts` — Writer wiring: append() before send(), cleanup on close. Integration point between keep-alive and scrollback.
- `src/lib/actions/workspaces.ts` — Session CRUD server actions (createSessionAction, renameSessionAction, killSessionAction, getWorkspaceSessionsAction).

### Existing Test Coverage (baseline)

| Area | Files | Tests | Coverage |
|------|-------|-------|----------|
| Keep-alive (unit + integration) | 2 | 33 | ConnectionRegistry, KeepAliveManager, ping behavior |
| Keep-alive warning (component) | 1 | 7 | Threshold rendering |
| Reconnection (backoff + reconnectId) | 2 | 17 | computeBackoff, getOrCreateReconnectId |
| Tab refit (ResizeObserver) | 1 | 4 | fit() on dimension change |
| Scrollback writer (unit) | 1 | ~15 | Append, flush, retry, ring buffer |
| Ring buffer (unit) | 1 | 9 | Capacity, FIFO, overflow |
| Scrollback API (route) | 1 | 20 | Pagination, validation, response formats |
| Hydration hook | 1 | 9 | State machine, fetch, write to xterm |
| Pagination hook | 1 | 8 | Cursor management, dedup, loading |
| History panel (component) | 1 | 7 | Rendering, empty state, loadMore |
| JumpToBottom (component) | 1 | 3 | Visibility, click |
| Tab manager (component) | 1 | 7 | Session CRUD, tab switching |
| Breadcrumbs (component) | 1 | ~8 | Session picker |
| Session actions (server) | 1 | ~10 | Create, rename, kill actions |
| Protocol (proxy) | 1 | ~6 | Encode/decode |
| **Total** | **17** | **~163 M006-related** | |

### What's Missing (S05 scope)

1. **Hydration ↔ WebSocket gating integration** — No test proves that `isGatingLiveData=true` actually buffers WebSocket data and `flushBufferedData()` drains it in order after hydration completes. Individual hooks are tested but the handoff between them is not.

2. **InteractiveTerminal full wiring** — No test renders InteractiveTerminal and verifies that hydration state changes flow through to banners, that reconnectId expiry triggers re-hydration, or that scroll-to-top shows the history panel.

3. **TerminalTabManager with M006 features** — Existing tab manager tests (from M005) don't cover KeepAliveWarning rendering, connection badges with reconnection states, or localStorage cleanup of reconnectId on tab kill.

4. **Scrollback API → hydration → xterm round-trip** — No test proves the API response format is correctly consumed by the hydration hook and written to xterm. The API tests and hook tests mock each other's boundaries.

5. **Proxy writer → API read path** — `scrollback-integration.test.ts` exists but is skipped without DATABASE_URL. A mock-based version proving the data format compatibility (seqNum ordering, binary chunk concatenation) would add value.

### Build Order

1. **Cross-slice integration tests first** — These are the highest-value tests: prove hydration↔WebSocket gating, scrollback write→read format compatibility, and reconnectId lifecycle across components. These directly validate the M006 acceptance criteria.

2. **Component integration tests second** — InteractiveTerminal rendering with all M006 hooks wired, verifying banner states, history panel visibility, jump-to-bottom behavior in context.

3. **Regression tests last** — TerminalTabManager with M006 features present, session CRUD still works, tab switching still preserves xterm instances. These are lower risk since M005 tests already cover the base behavior.

### Verification Approach

```bash
# All tests pass (including new S05 tests)
pnpm vitest run

# Terminal-proxy tests still pass
cd services/terminal-proxy && pnpm vitest run

# No new TypeScript errors
pnpm tsc --noEmit

# Total test count increased (currently 474 frontend + 88 proxy = 562)
# S05 should add 20-30 integration/regression tests
```

## Constraints

- No e2e framework exists — all tests must use vitest + @testing-library/react (frontend) or vitest (proxy). Adding Playwright is out of scope.
- `scrollback-integration.test.ts` requires DATABASE_URL — new integration tests should use mocks for CI reliability, with optional live-DB variants marked `skipIf(!DATABASE_URL)`.
- Pre-existing TypeScript errors in `council-queues.ts`, `task-queue.ts` (ioredis version mismatch) cause `pnpm tsc --noEmit` to exit non-zero — unrelated to M006.
- jsdom environment needed for component tests (set via `// @vitest-environment jsdom` comment).
- xterm.js is dynamically imported in InteractiveTerminal — tests mock it via `vi.mock('xterm')` pattern already established in `terminal-tab-refit.test.tsx`.

## Common Pitfalls

- **xterm.js mock complexity** — InteractiveTerminal dynamically imports xterm and FitAddon. Tests must mock both modules and provide Terminal/FitAddon constructors that return mock objects with the right interface (write, dispose, onScroll, loadAddon, open, etc.). Follow the pattern in `terminal-tab-refit.test.tsx`.
- **React strict mode double-effects** — Hydration hook uses `stateRef + cancelled` pattern instead of AbortController. Integration tests must account for potential double-invocation in strict mode.
- **Async act() wrapping** — Hook tests with fetch calls need careful `act()` + `flushAll()` patterns. Follow the established pattern in `useScrollbackHydration.test.ts`.
