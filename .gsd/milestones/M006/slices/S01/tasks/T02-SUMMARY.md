---
id: T02
parent: S01
milestone: M006
key_files:
  - src/hooks/useKeepAliveStatus.ts
  - src/components/workspaces/KeepAliveWarning.tsx
  - src/components/workspaces/TerminalTabManager.tsx
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/app/workspaces/[id]/terminal/terminal-client.tsx
  - src/app/workspaces/[id]/terminal/page.tsx
key_decisions:
  - Derived HTTP URL from NEXT_PUBLIC_TERMINAL_WS_URL by replacing ws:// with http:// rather than adding a separate env var — keeps configuration simple since the proxy serves both WS and HTTP on the same host:port
duration: 
verification_result: passed
completed_at: 2026-04-15T14:31:36.627Z
blocker_discovered: false
---

# T02: Add keep-alive polling hook, warning banner, and workspaceId to WebSocket URL for terminal UI

**Add keep-alive polling hook, warning banner, and workspaceId to WebSocket URL for terminal UI**

## What Happened

Created `useKeepAliveStatus` hook that polls the terminal-proxy's `/keepalive/status` endpoint every 30 seconds, deriving the HTTP URL from the existing `NEXT_PUBLIC_TERMINAL_WS_URL` env var by replacing `ws://` with `http://`. The hook extracts the per-workspace entry from the response and returns `{consecutiveFailures, lastSuccess, lastFailure, isLoading}`. Interval is cleaned up on unmount.

Created `KeepAliveWarning` component using shadcn's `Alert` with `variant="destructive"`. It renders nothing when `consecutiveFailures < 3` and shows a warning banner above the terminal tabs when the threshold is reached.

Mounted `KeepAliveWarning` in `TerminalTabManager` above the tab bar, passing the `workspaceId` prop.

Added `workspaceId` to `InteractiveTerminalProps` and included it in the WebSocket URL query parameters. Updated both call sites: `TerminalTabManager` (already had `workspaceId`) and the standalone terminal page (`terminal-client.tsx`), threading `workspaceId` from the route params through `TerminalClient` to `InteractiveTerminal`.

## Verification

Ran `pnpm tsc --noEmit` — no new TypeScript errors (all errors are pre-existing in unrelated files). Verified hook file exists, banner is mounted in TerminalTabManager, and workspaceId is present in InteractiveTerminal's WebSocket URL construction.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -q 'useKeepAliveStatus' src/hooks/useKeepAliveStatus.ts` | 0 | ✅ pass | 50ms |
| 2 | `grep -q 'KeepAliveWarning' src/components/workspaces/TerminalTabManager.tsx` | 0 | ✅ pass | 50ms |
| 3 | `grep -q 'workspaceId' src/components/workspaces/InteractiveTerminal.tsx` | 0 | ✅ pass | 50ms |
| 4 | `pnpm tsc --noEmit (filtered for changed files)` | 0 | ✅ pass | 15000ms |

## Deviations

Added workspaceId prop threading through the standalone terminal page (terminal-client.tsx and page.tsx) — not mentioned in the task plan but required to avoid TypeScript errors after adding workspaceId to InteractiveTerminalProps.

## Known Issues

None

## Files Created/Modified

- `src/hooks/useKeepAliveStatus.ts`
- `src/components/workspaces/KeepAliveWarning.tsx`
- `src/components/workspaces/TerminalTabManager.tsx`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`
