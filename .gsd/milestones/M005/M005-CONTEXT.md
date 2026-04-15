# M005: Workspace Terminals

**Gathered:** 2026-04-14
**Status:** Ready for planning

## Project Description

Persistent terminal management layer in the Hive dashboard. The user's primary frustration: closing a terminal kills all progress when working with agents in Coder workspaces. This milestone makes the web dashboard the primary interface for interactive workspace shells, with tmux providing persistence underneath so sessions survive browser closes, tab refreshes, and reconnects.

## Why This Milestone

The dashboard currently handles automated workflows (task submission, blueprint execution, template management) but offers no interactive workspace access. The user SSHs into workspaces manually, and closing the terminal loses all state. This milestone closes that gap — the dashboard becomes a single pane of glass for both automated and manual workspace interaction.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Open the dashboard, see all their Coder workspaces with live status
- Click into any workspace, see existing tmux sessions, create new ones
- Open multiple terminal tabs simultaneously across different workspaces
- Type commands, run vim, use any interactive tool — full bidirectional shell
- Close the browser, come back hours later, and reattach to the same tmux sessions with full scrollback intact
- Access Filebrowser, KasmVNC, and Coder management for any workspace directly from the dashboard

### Entry point / environment

- Entry point: `/workspaces` page in the Hive dashboard
- Environment: Browser (Next.js app running in Docker)
- Live dependencies involved: Coder API (workspace listing, PTY WebSocket), tmux (inside each workspace)

## Completion Class

- Contract complete means: Unit tests for UI components and state management pass, integration tests for WebSocket proxy logic pass
- Integration complete means: Terminal connects to a real Coder workspace via PTY WebSocket, tmux sessions persist across browser disconnects
- Operational complete means: Multiple simultaneous terminal tabs work without resource leaks, reconnection handles network interruptions gracefully

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- User can open the dashboard, navigate to a workspace, create a tmux session, type commands, close the browser tab, reopen it, and reattach to the same session with scrollback intact
- Multiple terminal tabs connected to different workspaces work simultaneously without interference
- External tool links (Filebrowser, KasmVNC, Coder) work for workspaces that have those services running

## Architectural Decisions

### Terminal Transport

**Decision:** Proxy Coder's native PTY WebSocket (`/api/v2/workspaceagents/{id}/pty`) through a Next.js API route.

**Rationale:** Coder already handles PTY allocation, resize, UTF-8 encoding, and authentication. We just proxy the WebSocket through our backend, adding Hive session auth. This avoids managing SSH child processes, stdin/stdout piping, and a custom resize protocol.

**Alternatives Considered:**
- Spawning `coder ssh` per terminal on the server — rejected because it requires managing child process lifecycles, stdin/stdout piping, and building our own resize protocol

### tmux Wrapping

**Decision:** All terminals always run inside tmux sessions — no bare shells.

**Rationale:** Persistence guarantee by design. Browser disconnect = tmux detach, not session loss. Reconnect = tmux attach with full scrollback. This is the core value proposition of the milestone.

**Alternatives Considered:**
- Optional tmux (allow bare shells) — rejected because it complicates the reconnection model and defeats the persistence purpose

### Session Naming

**Decision:** Auto-name tmux sessions from the current working directory, with rename capability.

**Rationale:** Zero friction to create (no modal asking for a name), easy to identify later (e.g., "hive", "second-brain"). User requested this specific UX.

**Alternatives Considered:**
- Named sessions (user types name upfront) — rejected as unnecessary friction for the common case

### External Tool Integration

**Decision:** Iframe-embed Filebrowser and KasmVNC with popup-out button; link-out for Coder dashboard.

**Rationale:** Rich integrated experience for workspace-scoped tools (Filebrowser, KasmVNC), link-out for the full management app (Coder dashboard). Falls back to popup-out buttons if iframe blocked by X-Frame-Options.

**Alternatives Considered:**
- Links-only for all tools — rejected because the user explicitly wanted iframe embedding for a more integrated experience

### Page Structure

**Decision:** New `/workspaces` top-level page in sidebar.

**Rationale:** Workspaces are a first-class concept that deserves its own navigation entry. Flow: workspace list → workspace detail → terminals + tool panels.

## Error Handling Strategy

**WebSocket lifecycle (critical path):**
- Browser loses connection temporarily (laptop sleep, network blip): Auto-reconnect with tmux reattach. Terminal shows "reconnecting..." overlay, not a navigation event. Scrollback survives because tmux holds it.
- Workspace goes offline while terminal is open: Terminal shows "workspace offline" state. No auto-reconnect loop — clear status and "reconnect when ready" button. Don't hammer a dead workspace.
- Coder API itself is down: Workspace list shows stale data with "last fetched" timestamp and warning banner. Already-open terminals keep working (WebSocket established), new connections fail gracefully.

**tmux edge cases:**
- tmux not available or crashed on a workspace: Show "no tmux available" error, disable session management. tmux is required — it's baked into all templates.
- Session disappears between list and attach: Catch attach failure, refresh session list, notify user.

**Iframe embedding failures:**
- Filebrowser/KasmVNC blocked by X-Frame-Options or CSP: Detect iframe load failure, automatically fall back to popup-out button with toast notification. Iframe is progressive enhancement.
- App not running on the workspace: Iframe shows connection error visibly.

**Multi-tab resource pressure:**
- 10+ terminal tabs: Each is a WebSocket. Warn after ~8 tabs as a nudge, not a hard limit.

## Risks and Unknowns

- Coder PTY WebSocket API is not officially documented — it's what Coder's own web terminal uses, so it's stable, but the contract could change between Coder versions
- Iframe embedding of Filebrowser and KasmVNC may be blocked by `X-Frame-Options` headers set by Coder's proxy — needs runtime testing, architecture accounts for fallback
- WebSocket upgrade through Next.js API routes may require custom server configuration depending on deployment mode

## Existing Codebase / Prior Art

- `src/lib/coder/client.ts` — CoderClient with `listWorkspaces()`, API token handling, workspace lifecycle management
- `src/lib/coder/types.ts` — Coder API type definitions
- `src/components/templates/TerminalPanel.tsx` — existing xterm.js component (write-only, SSE-based)
- `src/components/templates/TemplatesClient.tsx` — writeRef + lineHistory pattern for xterm.js
- `src/app/templates/` — existing page structure pattern to follow
- `src/components/app-sidebar.tsx` — sidebar navigation
- `templates/ai-dev/main.tf` — Coder subdomain proxy pattern for constructing tool URLs

## Relevant Requirements

- R035 — Dashboard lists all owner's Coder workspaces with live status, lazy-loaded tmux sessions
- R036 — Full bidirectional interactive terminal via xterm.js + WebSocket proxy
- R037 — All sessions tmux-backed, browser disconnect = tmux detach
- R038 — Multiple terminal tabs simultaneously
- R039 — tmux session lifecycle (create, rename, kill)
- R040 — Iframe-embedded Filebrowser and KasmVNC with popup-out
- R042 — WebSocket auto-reconnect with tmux reattach

## Scope

### In Scope

- List all Coder workspaces (owner's workspaces, all templates) with live status
- Per-workspace: lazy-fetch tmux sessions, create new sessions, kill sessions
- Full interactive bidirectional terminal in-browser via xterm.js + WebSocket
- Multiple terminal tabs open simultaneously across workspaces
- Session persistence — close browser, come back, reattach with scrollback
- Direct links/iframes to external tools per workspace: Coder management UI, Filebrowser, KasmVNC
- Construct links dynamically from Coder subdomain patterns

### Out of Scope / Non-Goals

- Workspace creation/deletion — permanently handled by Coder, link out only (R041)
- File browsing — handled by Filebrowser, iframe/link out only
- Desktop/VNC — handled by KasmVNC, iframe/link out only
- Changes to existing task/blueprint pipeline
- Agent-specific management UI (launching pi/claude from structured interface) — deferred

## Technical Constraints

- WebSocket proxy must keep Coder API token server-side (never exposed to browser)
- tmux is required on all target workspaces (baked into ai-dev template)
- Terminal latency must be indistinguishable from direct SSH — proxy hop must be imperceptible

## Integration Points

- Coder API — workspace listing (`/api/v2/workspaces`), agent info, PTY WebSocket (`/api/v2/workspaceagents/{id}/pty`)
- tmux — session listing (`tmux list-sessions`), create/attach/kill via PTY commands
- Filebrowser — iframe embedding via Coder subdomain proxy
- KasmVNC — iframe embedding via Coder subdomain proxy

## Testing Requirements

- Unit tests for React components (workspace list, terminal tabs, session management UI)
- Unit tests for WebSocket proxy connection logic (mockable)
- Integration tests for Coder API workspace fetching
- Manual UAT for end-to-end terminal flow: create session → type commands → close browser → reattach

## Acceptance Criteria

**S01 (Workspace Discovery):**
- /workspaces page lists all owner's workspaces with status badges
- Clicking a workspace shows its tmux sessions (lazy-loaded)
- External tool links/buttons render for each workspace

**S02 (Bidirectional Terminal):**
- User clicks "new terminal", gets a full interactive shell
- Can run vim, htop, any interactive command
- Close browser tab → reopen → reattach to same session with scrollback
- Auto-reconnect on network interruption with overlay

**S03 (Multi-Tab & Session Management):**
- Multiple tabs open simultaneously across workspaces
- Create sessions auto-named from cwd
- Rename and kill sessions from UI

**S04 (External Tools):**
- Filebrowser and KasmVNC render in iframes
- Popup-out button opens in new window
- Fallback to link-out if iframe blocked

## Open Questions

- Exact Coder PTY WebSocket protocol details (binary frames, resize messages) — needs investigation during S02
- Whether Coder's subdomain proxy sets X-Frame-Options that block iframes — runtime test during S04
