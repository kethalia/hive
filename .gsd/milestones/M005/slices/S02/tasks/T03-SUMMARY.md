---
id: T03
parent: S02
milestone: M005
key_files:
  - src/hooks/useTerminalWebSocket.ts
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/app/workspaces/[id]/terminal/page.tsx
  - src/app/workspaces/[id]/terminal/terminal-client.tsx
  - src/lib/actions/workspaces.ts
  - src/__tests__/lib/terminal/hooks.test.ts
key_decisions:
  - Split terminal page into server component (page.tsx) + client wrapper (terminal-client.tsx) — Next.js 16 Turbopack rejects ssr:false dynamic imports in Server Components
  - Use crypto.randomUUID() for reconnect ID — native browser API, no uuid dependency needed
  - Build WebSocket URL client-side from window.location to handle both http/https correctly without passing server URL to client
duration: 
verification_result: passed
completed_at: 2026-04-14T11:14:28.210Z
blocker_discovered: false
---

# T03: Build InteractiveTerminal component with xterm.js, WebSocket hook with exponential backoff reconnect, and terminal page route

**Build InteractiveTerminal component with xterm.js, WebSocket hook with exponential backoff reconnect, and terminal page route**

## What Happened

Built the client-side interactive terminal stack: a `useTerminalWebSocket` hook that manages WebSocket lifecycle with auto-reconnect (exponential backoff: 1s base, 2x factor, ±500ms jitter, 30s cap, 10 max attempts), and an `InteractiveTerminal` component that wires xterm.js bidirectional I/O through the hook to the T02 proxy.

The component dynamically imports xterm.js and FitAddon (no SSR), waits for `document.fonts.ready` before first fit, generates a per-tab reconnect UUID via `crypto.randomUUID()` for tmux session reattachment, and sends user input as JSON-encoded protocol messages from T01. Connection state is exposed via a colored badge (green/yellow/red) with workspace-offline detection on close code 4404.

The terminal page at `/workspaces/[id]/terminal` is a server component that resolves the workspace agent ID via a new `getWorkspaceAgentAction` server action, then renders the terminal through a client wrapper (required by Next.js 16 — `ssr: false` with `next/dynamic` is not allowed in Server Components).

Key deviation: Split the terminal page into `page.tsx` (server) + `terminal-client.tsx` (client wrapper) because Next.js 16 Turbopack rejects `dynamic(..., { ssr: false })` in Server Components.

## Verification

1. `pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts` — 8/8 backoff logic tests pass (exponential growth, jitter bounds, max cap, non-negative values)
2. `pnpm build` — succeeds, terminal page route visible at `/workspaces/[id]/terminal` (dynamic)
3. `grep -rq 'InteractiveTerminal' src/app/workspaces/` — component wired into page confirmed

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts` | 0 | ✅ pass | 164ms |
| 2 | `pnpm build` | 0 | ✅ pass | 12000ms |
| 3 | `grep -rq 'InteractiveTerminal' src/app/workspaces/` | 0 | ✅ pass | 50ms |

## Deviations

Split terminal page into page.tsx (server) + terminal-client.tsx (client wrapper) because Next.js 16 Turbopack does not allow `dynamic(..., { ssr: false })` in Server Components. The plan assumed a single page.tsx with dynamic import.

## Known Issues

none

## Files Created/Modified

- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/lib/actions/workspaces.ts`
- `src/__tests__/lib/terminal/hooks.test.ts`
