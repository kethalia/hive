---
id: T03
parent: S05
milestone: M006
key_files:
  - src/__tests__/integration/terminal-tab-manager-regression.test.tsx
key_decisions:
  - Used vi.hoisted() for useKeepAliveStatus mock state shared between vi.mock factory and test bodies, enabling per-test control of consecutiveFailures without module reimport — consistent with T02 pattern
  - Extended InteractiveTerminal stub with data-agent-id, data-workspace-id, and data-has-conn-callback attributes to verify prop wiring through next/dynamic mock
duration: 
verification_result: passed
completed_at: 2026-04-15T17:58:36.416Z
blocker_discovered: false
---

# T03: Add TerminalTabManager regression tests confirming session CRUD, tab switching, KeepAliveWarning integration, and reconnectId cleanup coexist with M006 components

**Add TerminalTabManager regression tests confirming session CRUD, tab switching, KeepAliveWarning integration, and reconnectId cleanup coexist with M006 components**

## What Happened

Created `src/__tests__/integration/terminal-tab-manager-regression.test.tsx` with 8 regression tests across 4 groups proving pre-existing terminal tab features work correctly with M006 components mounted:

**Group 1 — Session CRUD with M006 present (4 tests):** Loads existing sessions and renders InteractiveTerminal stubs with correct props. Creates new tabs via createSessionAction. Renames tabs via renameSessionAction with correct args. Kills tabs via killSessionAction and verifies tab removal.

**Group 2 — Tab switching preserves M006 state (1 test):** Creates multiple tabs, verifies both InteractiveTerminal stubs render with correct session/agent/workspace props and onConnectionStateChange callback. Verifies display:block/none pattern for active/inactive tabs, then switches tabs and confirms the display states swap.

**Group 3 — KeepAliveWarning integration (2 tests):** Uses vi.hoisted() mock for useKeepAliveStatus to control consecutiveFailures. Verifies the destructive Alert banner appears when failures >= 3 (threshold) with correct text content, and is absent when failures < 3.

**Group 4 — ReconnectId cleanup on kill (1 test):** Sets reconnectId entries in localStorage for two sessions, kills one session's tab, verifies the killed session's localStorage entry is removed while the other session's entry is preserved.

Mock strategy follows the existing terminal-tab-manager.test.tsx patterns: mock next/dynamic to return an InteractiveTerminal stub (extended with data attributes for prop verification), mock server actions as vi.fn(), mock useKeepAliveStatus via vi.hoisted() for per-test control, mock UI components (Button, Input, Badge, Alert) as thin HTML stubs.

## Verification

Ran `pnpm vitest run src/__tests__/integration/terminal-tab-manager-regression.test.tsx` — 8 tests pass in 66ms. Ran `pnpm vitest run` full suite — 63 files, 504 tests pass, 0 regressions. Ran `pnpm tsc --noEmit` — all errors are pre-existing (ioredis version conflicts, T01 mock types, Prisma types); no new TypeScript errors introduced.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/integration/terminal-tab-manager-regression.test.tsx` | 0 | ✅ pass | 720ms |
| 2 | `pnpm vitest run` | 0 | ✅ pass | 4690ms |
| 3 | `pnpm tsc --noEmit` | 2 | ✅ pass (all errors pre-existing) | 12000ms |

## Deviations

none

## Known Issues

Pre-existing TypeScript errors in terminal-data-flow.test.ts (mock type mismatches from T01), ioredis version conflicts, and Prisma type issues — none introduced by this task.

## Files Created/Modified

- `src/__tests__/integration/terminal-tab-manager-regression.test.tsx`
