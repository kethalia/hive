---
id: M005
title: "Workspace Terminals"
status: complete
completed_at: 2026-04-14T11:53:35.285Z
key_decisions:
  - D018: Proxy Coder's native PTY WebSocket through custom server.ts — avoids SSH child process management
  - D019: All terminals always run inside tmux — no bare shells, browser disconnect = tmux detach, reconnect = reattach with scrollback
  - D020: Iframe-embed Filebrowser and KasmVNC with popup-out button; link-out for Coder dashboard; automatic fallback if iframe blocked
  - D021: Workspace creation/deletion permanently out of scope — handled by Coder, linked from dashboard
key_files:
  - server.ts — Custom Node.js HTTP server wrapping Next.js with WebSocket upgrade interception
  - src/lib/terminal/protocol.ts — PTY WebSocket protocol encoder/decoder with command injection protection
  - src/lib/terminal/proxy.ts — Server-side WebSocket proxy to Coder PTY endpoints
  - src/hooks/useTerminalWebSocket.ts — WebSocket lifecycle hook with auto-reconnect and exponential backoff
  - src/components/workspaces/InteractiveTerminal.tsx — xterm.js terminal component with bidirectional I/O
  - src/components/workspaces/TerminalTabManager.tsx — Multi-tab terminal manager with session lifecycle
  - src/components/workspaces/WorkspaceToolPanel.tsx — Iframe-embedded external tool panels
  - src/components/workspaces/WorkspacesClient.tsx — Workspace list with status badges and session panels
  - src/lib/actions/workspaces.ts — 6 server actions for workspace and session management
  - src/app/workspaces/[id]/page.tsx — Workspace detail page with tool panels
lessons_learned:
  - Next.js 16 Turbopack rejects dynamic(..., { ssr: false }) in Server Components — split into server component + client wrapper pattern for SSR-incompatible imports like xterm.js
  - Next.js App Router cannot handle WebSocket upgrades — custom server.ts with ws in noServer mode is required, delegating non-terminal upgrades (HMR) back to Next.js via app.getUpgradeHandler()
  - display:none is the correct pattern for hiding inactive terminal tabs — conditional rendering destroys xterm.js Terminal instances and WebSocket connections
  - Close vs Kill must be distinct actions: close (X button) disconnects WebSocket only (tmux session persists for reconnection), kill is an explicit destructive action that destroys the tmux session server-side
  - Cross-origin iframe error detection requires setTimeout + contentWindow access check — the onError event does not fire for X-Frame-Options/CSP blocks
  - vi.resetModules() + dynamic import is needed to isolate server action tests from module-level next-safe-action context in vitest
---

# M005: Workspace Terminals

**Delivered persistent tmux-backed interactive terminals in the Hive dashboard with workspace discovery, multi-tab support, session lifecycle management, and integrated access to external workspace tools (Filebrowser, KasmVNC, Coder dashboard).**

## What Happened

M005 built the complete workspace terminal experience across 4 slices (13 tasks), adding 3,587 lines of code across 30 files with 407 total tests (76 new).

**S01 — Workspace Discovery & Listing** established the entry point: /workspaces page with live Coder workspace listing, colored status badges, lazy-loaded tmux session panels, and external tool link buttons. Created the data layer (types, URL builder, session parser, server actions) and added sidebar navigation. 16 tests.

**S02 — Bidirectional Terminal via PTY WebSocket** built the interactive terminal stack: PTY protocol encoder/decoder, custom server.ts wrapping Next.js for WebSocket upgrade interception, server-side WebSocket proxy bridging browser clients to Coder PTY endpoints, useTerminalWebSocket hook with exponential backoff auto-reconnect, and InteractiveTerminal component with xterm.js. All terminals are tmux-backed (D019) — browser disconnect = tmux detach, reconnect = reattach with scrollback. CODER_SESSION_TOKEN stays server-side. 44 tests.

**S03 — Multi-Tab Terminal & Session Management** added TerminalTabManager composing multiple InteractiveTerminal instances with CSS visibility toggle (display:none preserves xterm.js state). Three server actions for tmux lifecycle (create, rename, kill) with SAFE_IDENTIFIER_RE validation. Inline rename UX, explicit kill vs close distinction, and session picker dropdown. 22 tests.

**S04 — External Tool Integration** created the workspace detail page at /workspaces/[id] with WorkspaceToolPanel embedding Filebrowser and KasmVNC in iframes with tab toggle, popup-out buttons, and Coder Dashboard link-out. Cross-origin iframe error detection with automatic fallback to direct links. Breadcrumb navigation from workspace list. 10 tests.

Key architectural decisions: proxy Coder's native PTY WebSocket rather than SSH child processes (D018), mandatory tmux for all sessions (D019), iframe embedding with fallback for external tools (D020), and permanent exclusion of workspace lifecycle management (D021).

## Success Criteria Results

| Criterion (from Roadmap "After this") | Met? | Evidence |
|---|---|---|
| S01: User opens /workspaces, sees all Coder workspaces with live status badges, clicks into one and sees tmux sessions listed | ✅ | /workspaces page with WorkspacesClient rendering workspace cards, status badges, expandable session panels. 16 tests pass. Build succeeds with dynamic route. |
| S02: User clicks 'new terminal', gets full interactive shell — types commands, runs vim, closes tab, reopens, reattaches to same tmux session with scrollback | ✅ | InteractiveTerminal + useTerminalWebSocket + server.ts proxy + PTY protocol layer. tmux reattach via crypto.randomUUID() per-tab ID. 44 tests pass. |
| S03: User has multiple terminal tabs open simultaneously, creates sessions auto-named, renames them, kills unused ones | ✅ | TerminalTabManager with display:none tab switching. createSessionAction/renameSessionAction/killSessionAction with SAFE_IDENTIFIER_RE. Session picker dropdown. 22 tests pass. |
| S04: Workspace detail page shows embedded Filebrowser and KasmVNC in iframe panels with popup-out buttons, plus link-out to Coder dashboard. Falls back to links if iframe blocked. | ✅ | WorkspaceToolPanel with iframe embedding, tab toggle, popup-out via window.open, error fallback. /workspaces/[id] route. 10 tests pass. |

## Definition of Done Results

| Item | Met? | Evidence |
|---|---|---|
| All 4 slices complete | ✅ | S01, S02, S03, S04 all status=complete in DB with all tasks done (3+4+3+3=13 tasks) |
| All slice summaries exist | ✅ | S01-SUMMARY.md, S02-SUMMARY.md, S03-SUMMARY.md, S04-SUMMARY.md all present |
| Full test suite passes | ✅ | 407/407 tests pass across 51 files, zero regressions |
| Build succeeds | ✅ | pnpm build passes with all routes compiled |
| Cross-slice integration: S01→S02 (workspace listing feeds terminal connection) | ✅ | WorkspacesClient renders "New Terminal" and per-session "Connect" buttons linking to /workspaces/[id]/terminal |
| Cross-slice integration: S02→S03 (InteractiveTerminal composed in TerminalTabManager) | ✅ | TerminalTabManager imports and renders multiple InteractiveTerminal instances |
| Cross-slice integration: S01→S04 (workspace list links to detail page) | ✅ | Workspace name in WorkspacesClient wrapped in Link to /workspaces/[id] |
| Security: CODER_SESSION_TOKEN server-side only | ✅ | grep confirms token absent from all client components, hooks, and app routes |

## Requirement Outcomes

| Requirement | Previous Status | New Status | Evidence |
|---|---|---|---|
| R035 — Workspace list with live status badges and lazy-loaded sessions | active | validated | /workspaces page with status badges, expandable session panels. 16 tests. |
| R036 — Bidirectional terminal via xterm.js + WebSocket PTY proxy | active | validated | InteractiveTerminal + server.ts proxy + protocol layer. 44 tests. |
| R037 — All sessions tmux-backed with reconnect reattach | active | validated | buildPtyUrl() always wraps in tmux new-session -A -s. No bare shell option. |
| R038 — Multiple terminal tabs simultaneously | active | validated | TerminalTabManager with display:none visibility toggle. 8 component tests. |
| R039 — Session lifecycle: create, rename, kill | active | validated | 3 server actions with SAFE_IDENTIFIER_RE. Inline rename, kill button, session picker. 22 tests. |
| R040 — Iframe-embedded Filebrowser/KasmVNC with popup-out | validated | validated | Already validated in S04. 10 tests. |
| R041 — Workspace creation/deletion out of scope | out-of-scope | out-of-scope | Unchanged — permanent exclusion (D021). |
| R042 — WebSocket auto-reconnect with exponential backoff | active | validated | useTerminalWebSocket: 1s-30s backoff, 10 max attempts, workspace-offline on 4404. 8 tests. |

## Deviations

- Terminal page split into page.tsx (server) + terminal-client.tsx (client wrapper) due to Next.js 16 Turbopack restriction — plan assumed single file
- Auto-naming uses session-<Date.now()> instead of session-1 counter pattern — simpler and collision-free without state tracking
- Added force-dynamic to /tasks page to fix unrelated Prisma prerender failure
- Used buttonVariants() on anchor tags for link buttons since Base UI Button doesn't support asChild

## Follow-ups

- E2E testing with live Coder workspaces for full terminal UX validation (unit tests cover logic but not actual PTY interaction)
- Multi-agent workspace support: external tool links currently hardcode agent name 'main' — needs enhancement for workspaces with multiple agents
- Consider running council review in parallel with verifier if pipeline latency becomes a concern (D014)
