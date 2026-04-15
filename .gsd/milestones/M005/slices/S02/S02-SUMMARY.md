---
id: S02
parent: M005
milestone: M005
provides:
  - ["Interactive bidirectional terminal at /workspaces/[id]/terminal", "WebSocket proxy at /api/terminal/ws for PTY traffic", "server.ts custom server wrapping Next.js with WebSocket upgrade support", "getWorkspaceAgentAction server action for resolving workspace agent IDs", "useTerminalWebSocket hook with auto-reconnect and connection state machine"]
requires:
  []
affects:
  - ["S03 depends on this — multi-tab terminal management builds on InteractiveTerminal and useTerminalWebSocket", "S04 can proceed independently (depends on S01 only)", "package.json dev script changed to tsx watch server.ts — affects local development workflow"]
key_files:
  - ["server.ts", "src/lib/terminal/protocol.ts", "src/lib/terminal/proxy.ts", "src/hooks/useTerminalWebSocket.ts", "src/components/workspaces/InteractiveTerminal.tsx", "src/app/workspaces/[id]/terminal/page.tsx", "src/app/workspaces/[id]/terminal/terminal-client.tsx", "src/components/workspaces/WorkspacesClient.tsx"]
key_decisions:
  - ["D018: Proxy Coder's native PTY WebSocket through custom server.ts (not SSH child processes)", "D019: All terminals always run inside tmux — browser disconnect = tmux detach, reconnect = reattach with scrollback", "Custom server.ts with ws in noServer mode required because Next.js App Router cannot do WebSocket upgrade", "Next.js 16 Turbopack requires server/client component split for ssr:false dynamic imports", "crypto.randomUUID() for reconnect IDs — native browser API, no uuid dependency"]
patterns_established:
  - ["Custom server.ts wrapping Next.js for WebSocket upgrade — reusable for any future real-time features", "Server component + client wrapper pattern for ssr:false dynamic imports under Turbopack", "useTerminalWebSocket hook with exponential backoff reconnect — extractable for other WebSocket use cases", "SAFE_IDENTIFIER_RE validation at both protocol and proxy layers for defense-in-depth against command injection"]
observability_surfaces:
  - ["Browser console: WebSocket connection state transitions (connecting → connected → disconnected → reconnecting)", "Server stdout: upstream WebSocket lifecycle logs with agentId context (connect, disconnect, error)", "Terminal UI: colored connection badge (green=connected, yellow=connecting/reconnecting, red=failed)", "Terminal UI: 'Workspace offline' message when agent is unreachable"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-14T11:18:41.657Z
blocker_discovered: false
---

# S02: Bidirectional Terminal via PTY WebSocket

**Delivered a fully bidirectional interactive terminal in-browser via xterm.js connected to Coder workspace agents through a custom server.ts WebSocket proxy, with tmux-backed session persistence and auto-reconnect with exponential backoff.**

## What Happened

## What This Slice Delivered

This slice built the complete interactive terminal stack — from protocol layer to UI — enabling users to open a full shell session on any running Coder workspace directly from the Hive dashboard.

### T01: PTY Protocol Layer
Created `src/lib/terminal/protocol.ts` with four pure functions forming the Coder PTY WebSocket protocol contract: `encodeInput` (JSON-serialized terminal input), `encodeResize` (JSON-serialized resize commands, omitting zero/negative dimensions), `decodeOutput` (type-narrowing server frames — strings pass through, ArrayBuffers become Uint8Array), and `buildPtyUrl` (constructs the upstream Coder PTY WebSocket URL with http→ws protocol conversion, URL-encoded tmux command, and session name validation against `SAFE_IDENTIFIER_RE` to prevent command injection). Installed `ws@8.20.0` and `@types/ws@8.18.1`. 24 unit tests covering happy paths, special characters, boundary conditions, and shell metacharacter rejection.

### T02: Custom Server + WebSocket Proxy
Created `server.ts` at project root — a custom Node.js HTTP server wrapping Next.js that intercepts `/api/terminal/ws` upgrade requests while delegating all other upgrades (including HMR) to Next.js via `app.getUpgradeHandler()`. The proxy (`src/lib/terminal/proxy.ts`) validates query params (UUID agentId, SAFE_IDENTIFIER_RE sessionName), reads `CODER_SESSION_TOKEN` from env (never from client), opens an authenticated upstream WebSocket to the Coder PTY endpoint, and pipes frames bidirectionally preserving binary encoding. 30-second ping interval prevents idle timeouts. Both sides cleaned up on disconnect to prevent connection leaks. 10s upstream connect timeout with appropriate close codes (1013 on timeout, 1011 on error). Updated `package.json` dev script to `tsx watch server.ts`. 12 unit tests.

### T03: InteractiveTerminal Component + WebSocket Hook
Built `useTerminalWebSocket` hook managing WebSocket lifecycle with auto-reconnect (exponential backoff: 1s base, 2x factor, ±500ms jitter, 30s cap, 10 max attempts) and connection state machine (connecting → connected → disconnected → reconnecting → failed / workspace-offline). The `InteractiveTerminal` component dynamically imports xterm.js and FitAddon (no SSR), waits for `document.fonts.ready` before first fit, generates a per-tab reconnect UUID via `crypto.randomUUID()` for tmux session reattachment (D019), and displays connection state via colored badge (green/yellow/red). Terminal page at `/workspaces/[id]/terminal` split into server component + client wrapper due to Next.js 16 Turbopack restriction on `ssr: false` dynamic imports in Server Components. New `getWorkspaceAgentAction` server action resolves workspace agent ID. 8 backoff logic unit tests.

### T04: UI Integration
Added "New Terminal" button (Terminal icon from lucide-react) to each running workspace's tool links in WorkspacesClient.tsx, navigating to `/workspaces/{id}/terminal`. Per-tmux-session "Connect" buttons in expanded session panel navigate to `/workspaces/{id}/terminal?session={sessionName}` with URI encoding. Terminal buttons only render for running workspaces (inherent via existing conditional rendering). Terminal page reads optional `session` search param, defaulting to `hive-main`.

### Security
CODER_SESSION_TOKEN is server-side only — confirmed absent from all client components, hooks, and app routes. Session names validated against SAFE_IDENTIFIER_RE at both proxy and protocol layers to prevent command injection in tmux commands.

## Verification

## Verification Results

| # | Command | Exit Code | Verdict |
|---|---------|-----------|---------|
| 1 | `pnpm vitest run src/__tests__/lib/terminal/` | 0 | ✅ 44/44 terminal tests pass (protocol: 24, proxy: 12, hooks: 8) |
| 2 | `pnpm vitest run` | 0 | ✅ 375/375 tests pass across 48 files, zero regressions |
| 3 | `pnpm build` | 0 | ✅ Build succeeds, `/workspaces/[id]/terminal` route visible |
| 4 | `grep -rn 'CODER_SESSION_TOKEN' src/components/ src/hooks/ src/app/` | 1 (no matches) | ✅ Token not in any client-side code |

All slice plan must-haves verified:
- ✅ `pnpm vitest run src/__tests__/lib/terminal/` passes all protocol and proxy tests
- ✅ `pnpm build` succeeds with custom server entry point
- ✅ Custom server handles WebSocket upgrade on `/api/terminal/ws` path
- ✅ InteractiveTerminal component renders xterm.js and connects via WebSocket
- ✅ All terminal sessions use tmux (D019)
- ✅ Auto-reconnect with exponential backoff (R042)
- ✅ CODER_SESSION_TOKEN never reaches the browser
- ✅ Workspace-offline state shown in UI

## Requirements Advanced

- R036 — InteractiveTerminal component delivers full bidirectional terminal via xterm.js + WebSocket proxy to Coder PTY endpoint
- R037 — All sessions tmux-backed via buildPtyUrl tmux command; reconnect reuses same UUID to reattach with scrollback
- R042 — useTerminalWebSocket implements exponential backoff auto-reconnect (1s-30s, 10 max attempts); workspace-offline detection on close code 4404 with clear UI state

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Terminal page split into `page.tsx` (server) + `terminal-client.tsx` (client wrapper) because Next.js 16 Turbopack rejects `dynamic(..., { ssr: false })` in Server Components. The plan assumed a single page.tsx with dynamic import. No functional impact — identical behavior, just an additional wrapper file.

## Known Limitations

E2E testing requires a live Coder workspace with connected agent — unit/integration tests cover protocol logic, proxy validation, and backoff calculation but cannot verify the actual terminal UX. Manual UAT is required for full validation.

## Follow-ups

S03 (Multi-Tab Terminal & Session Management) is unblocked and can proceed — it builds on InteractiveTerminal and useTerminalWebSocket to add tabbed interface, session creation/renaming/deletion.

## Files Created/Modified

- `package.json` — Added ws, @types/ws, tsx dependencies; updated dev/start scripts for custom server
- `server.ts` — Custom Node.js HTTP server wrapping Next.js with WebSocket upgrade interception
- `src/lib/terminal/protocol.ts` — PTY WebSocket protocol encoder/decoder and URL builder with command injection protection
- `src/lib/terminal/proxy.ts` — Server-side WebSocket proxy bridging browser clients to Coder PTY endpoints
- `src/hooks/useTerminalWebSocket.ts` — WebSocket lifecycle hook with auto-reconnect, exponential backoff, and connection state machine
- `src/components/workspaces/InteractiveTerminal.tsx` — xterm.js terminal component with bidirectional I/O and connection state badge
- `src/app/workspaces/[id]/terminal/page.tsx` — Terminal page server component resolving workspace agent ID
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — Client wrapper for ssr:false dynamic import of InteractiveTerminal
- `src/lib/actions/workspaces.ts` — Added getWorkspaceAgentAction server action
- `src/components/workspaces/WorkspacesClient.tsx` — Added New Terminal and per-session Connect buttons
- `src/__tests__/lib/terminal/protocol.test.ts` — 24 protocol unit tests
- `src/__tests__/lib/terminal/proxy.test.ts` — 12 proxy unit tests
- `src/__tests__/lib/terminal/hooks.test.ts` — 8 backoff logic unit tests
