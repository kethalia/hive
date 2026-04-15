# M006: Persistent Terminal Sessions

**Gathered:** 2026-04-15
**Status:** Ready for planning

## Project Description

Terminal sessions in Hive's workspace UI lose state after as little as 5 minutes of inactivity. When the user switches between session tabs, the first session shows a fresh prompt with no scrollback and no running processes. The tmux session still exists (same name visible in session list), but the terminal appears reset. This is a critical bug blocking real workflow continuity — the user runs dev servers and long-running processes that must persist for days.

## Why This Milestone

The user's terminal workflow is broken. They create tmux sessions for interactive development (running `pnpm dev`, debugging, monitoring logs) and expect these to persist indefinitely. Three independent failures compound to make sessions feel ephemeral:

1. **Workspace auto-stop:** The ai-dev Coder template has `autostop_requirement = "always"` with a 24h TTL and 1h activity bumps. When the WebSocket drops and Hive stops retrying, Coder stops seeing activity — the workspace drifts toward auto-stop, killing everything.
2. **Reconnection hard limit:** `useTerminalWebSocket` gives up after 10 attempts with exponential backoff (~2 minutes). After that, the connection is permanently dead until page refresh.
3. **No scrollback persistence:** xterm.js holds scrollback only in browser memory (10,000 lines). Any reconnection, tab switch, or browser close permanently loses all terminal history.

This is imperative — the user's exact words: "nothing is closed automatically, never."

## User-Visible Outcome

### When this milestone is complete, the user can:

- Run `pnpm dev` in a tmux session, close the browser, come back the next day, and see the full scrollback with the process still running
- Switch between multiple terminal tabs without losing any scrollback in any tab
- Scroll up through days of terminal history with smooth virtual scrolling
- See a clear "reconnecting..." banner when the WebSocket drops, with automatic recovery

### Entry point / environment

- Entry point: `/workspaces/[id]/terminal` page in Hive dashboard
- Environment: browser + Next.js custom server (server.ts) + terminal-proxy service + Coder workspaces
- Live dependencies involved: Coder API (workspace activity), Postgres (scrollback storage), WebSocket (terminal I/O)

## Completion Class

- Contract complete means: unit tests prove scrollback CRUD, reconnection logic, keep-alive scheduling, virtual scroll chunk loading
- Integration complete means: terminal-proxy actually writes to Postgres, frontend actually hydrates from Postgres on reconnect, keep-alive actually pings Coder API
- Operational complete means: workspace stays alive 24h+ with no browser, scrollback survives proxy restart, reconnection works after real network interruption

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A terminal session with a running process (`pnpm dev` or similar) persists through browser close, 24h wait, and browser reopen — process still running, full scrollback visible
- Two terminal tabs can be used alternately without either losing scrollback
- WebSocket disconnect and reconnect restores terminal state seamlessly without manual page refresh

## Architectural Decisions

### Scrollback storage backend

**Decision:** Postgres for scrollback persistence, not Redis

**Rationale:** User needs scrollback to survive for days. Postgres is already the durable store. Redis is in-memory and loses data on restart. The write latency tradeoff is acceptable with chunked batch writes.

**Alternatives Considered:**
- Redis streams — fast but ephemeral; Redis restart loses all history
- Filesystem — no query capability, harder to manage lifecycle

### Reconnection strategy

**Decision:** Infinite retries with exponential backoff capped at 60s

**Rationale:** The current 10-attempt hard limit is the root cause of the "fresh prompt" bug. The user's requirement is "nothing is closed automatically, never." There is no acceptable number of retry attempts — it must be infinite.

**Alternatives Considered:**
- Increased but finite limit (100 attempts) — still fails eventually during long disconnections
- Manual reconnect button only — bad UX, user may not notice disconnect

### Workspace keep-alive mechanism

**Decision:** Server-side keep-alive pings to Coder API, independent of browser state

**Rationale:** Browser tabs get suspended by the OS. Browser-side pings die when the tab is backgrounded or the browser is closed. Only server-side pings guarantee the workspace stays alive. The keep-alive service tracks which workspaces have active terminal sessions and pings Coder's activity API on a schedule.

**Alternatives Considered:**
- Browser-side WebSocket pings only — dies when browser closes, defeats the purpose
- Disable workspace auto-stop globally — too coarse, task workspaces should still clean up

### Virtual scrolling approach

**Decision:** Custom virtual scroll layer over xterm.js with Postgres-backed chunk loading

**Rationale:** User explicitly requested virtual lists to avoid browser memory pressure from unlimited scrollback. Load visible viewport + buffer into xterm.js, lazy-load older chunks on scroll-up.

**Alternatives Considered:**
- xterm.js built-in scrollback (10K lines, hydrate from Postgres on reconnect) — simpler but caps history and loads everything into memory

## Error Handling Strategy

**Postgres down during scrollback write:** Buffer PTY output in terminal-proxy memory (bounded 50MB ring buffer per session). Retry writes with exponential backoff. If buffer fills, drop oldest unbatched chunks. Terminal never freezes — persistence is best-effort during outages.

**Postgres down during scrollback read:** Show live terminal immediately. Display "History temporarily unavailable" banner. Retry loading in background. Hydrate silently when Postgres recovers.

**Postgres slow (high write latency):** Batch writes every 5 seconds or 1000 lines, whichever comes first. Worst case: lose 5 seconds of output if proxy crashes between flushes.

**Keep-alive ping fails:** Retry every 30s. After 3 consecutive failures, show warning banner: "Keep-alive failed — workspace may auto-stop." Never silently let workspace drift toward auto-stop.

**Keep-alive fails and workspace actually stops:** Detect via WebSocket close + workspace status check. Show "Workspace stopped" state with "Restart workspace" button. On restart, reattach to same tmux session, hydrate scrollback from Postgres.

**WebSocket drops:** Infinite reconnect with exponential backoff (1s → 2s → 4s → ... → 60s cap). "Reconnecting..." banner with attempt counter and manual "Reconnect now" button. On success, check PTY alive → reattach or create new PTY on same tmux session.

**reconnectId expired:** Create new PTY targeting same tmux session name. Visual seam where old output ends and new PTY begins. Scrollback from Postgres fills in above.

**Terminal-proxy crashes:** All WebSocket connections drop. Frontend shows "Terminal proxy offline — reconnecting..." Proxy restarts via Docker restart policy. Frontend reconnects automatically. In-memory buffer lost — at most 5 seconds of output. Postgres has everything up to last flush.

**Browser tab suspended:** Server-side keep-alive handles workspace persistence. Tab wake-up triggers WebSocket reconnect, PTY reattach, scrollback hydration. Terminal feels like you never left.

**Browser closed entirely:** Server-side keep-alive continues. Scrollback writes continue via proxy (PTY still producing output). On browser reopen, session list shows all active sessions. Select one → full hydration from Postgres → attach to live PTY.

**Duplicate chunks (retry after ambiguous failure):** Monotonically increasing sequence numbers per session. `INSERT ... ON CONFLICT (session_id, seq) DO NOTHING`. Idempotent writes.

**Virtual scroll rapid scroll-up:** Fetch chunks in parallel, prioritize visible viewport. Show loading skeleton for pending chunks. Never block scrolling.

**Large scrollback (100K+ lines):** Postgres handles it. Virtual list loads only visible content. No browser memory pressure. Optional manual "Clear history" button — never auto-clear.

**Concurrent reads and writes:** New output appends at bottom. User scrolled up → new content doesn't force jump to bottom. "Jump to bottom" button appears when scrolled away from live output.

## Risks and Unknowns

- Coder API activity bump mechanism — need to confirm the exact API call for extending workspace activity. The template has `autostop_requirement` but the API endpoint for programmatic activity bumps needs verification.
- xterm.js virtual scrolling — xterm.js manages its own scrollback buffer internally. Replacing it with a virtual layer that fetches from Postgres requires either overriding the built-in scrollback or building a custom scroll container around xterm.js. This is the highest technical risk.
- Terminal-proxy Postgres integration — the proxy currently runs as a standalone service with its own Dockerfile. Adding Postgres connectivity requires either a shared DB connection or a new API layer between proxy and the Next.js app.
- WebSocket proxy output interception — to write scrollback, the proxy must intercept PTY output flowing through the WebSocket. This needs to happen without adding latency to the live terminal stream.

## Existing Codebase / Prior Art

- `services/terminal-proxy/src/proxy.ts` — WebSocket proxy between browser and Coder PTY. This is where output interception for scrollback writes would happen.
- `services/terminal-proxy/src/protocol.ts` — Binary frame protocol (input/resize/output types). Output frames (type 1) carry the PTY data that needs persisting.
- `src/hooks/useTerminalWebSocket.ts` — Frontend WebSocket hook with the current 10-attempt reconnect logic. Needs infinite retry refactor.
- `src/components/workspaces/InteractiveTerminal.tsx` — xterm.js component. Needs virtual scrolling and scrollback hydration integration.
- `src/components/workspaces/TerminalTabManager.tsx` — Multi-tab manager. Tab switching already uses display:none to preserve xterm instances.
- `src/lib/actions/workspaces.ts` — Server actions for workspace/session operations. Keep-alive service may live near here.
- `templates/ai-dev/main.tf` — Coder template with `autostop_requirement = "always"` and TTL settings.
- `prisma/schema.prisma` — Database schema. Needs new table for scrollback chunks.
- `server.ts` — Custom Next.js server handling WebSocket upgrade. Keep-alive service could be initialized here.

## Relevant Requirements

- R043 — Workspace keep-alive, server-side, independent of browser
- R044 — Infinite WebSocket reconnection
- R045 — Postgres-backed scrollback persistence
- R046 — Virtual scrolling for unlimited history
- R047 — Scrollback hydration on reconnect
- R048 — Expired reconnectId targets same tmux session
- R049 — Sessions persist until explicitly deleted
- R050 — Keep-alive failure warning in UI
- R051 — Postgres write failure buffering
- R052 — Tab switching preserves scrollback
- R053 — Process continuity via workspace persistence

## Scope

### In Scope

- Server-side workspace keep-alive service (pings Coder API)
- Infinite WebSocket reconnection (remove 10-attempt limit)
- Postgres schema and storage for scrollback chunks
- Terminal-proxy output interception and Postgres writes
- Scrollback hydration on reconnect/browser reopen
- Virtual scrolling with lazy chunk loading
- Reconnection UI (banner, manual button, status indicators)
- Keep-alive failure warnings in UI
- End-to-end integration proving 24h+ persistence

### Out of Scope / Non-Goals

- Task workspace cleanup behavior (separate system, R055)
- Changes to Coder's PTY API itself
- Coder template architecture changes beyond TTL settings
- Multi-user session sharing
- Session recording/playback

## Technical Constraints

- Terminal-proxy is a separate Docker service — Postgres connectivity must be added without coupling it to the Next.js app
- xterm.js has its own internal scrollback buffer — virtual scrolling must work with or around this, not fight it
- The WebSocket proxy handles binary frames (protocol.ts) — output interception must be zero-copy or near-zero-copy to avoid latency
- The custom server.ts handles WebSocket upgrade — keep-alive service initialization must integrate with the existing server lifecycle
- Coder workspace activity is tracked by the Coder agent — the keep-alive must use Coder's official API mechanism

## Integration Points

- Coder API — workspace activity bumps to prevent auto-stop
- Postgres — new scrollback_chunks table for persistent storage
- Terminal-proxy — output interception, Postgres writes, memory buffering
- xterm.js — virtual scrolling integration, scrollback hydration
- useTerminalWebSocket — infinite reconnection, hydration trigger
- server.ts — keep-alive service lifecycle management

## Testing Requirements

- **Unit tests:** Postgres scrollback CRUD (write chunk, read range, dedup by sequence, delete session), reconnection logic (infinite retry, backoff calculation, reconnectId expiry handling), keep-alive scheduler (ping scheduling, failure counting, warning threshold), virtual scroll chunk resolver (viewport calculation, chunk fetching, cache management)
- **Integration tests:** Terminal-proxy → Postgres write path (real output → stored chunks), hydration path (Postgres → xterm.js on reconnect), keep-alive → Coder API (mock API, verify ping scheduling)
- **Manual UAT:** Open two sessions, run long process in one, close browser, wait 1h+, reopen — verify process running, scrollback intact, both tabs functional

## Acceptance Criteria

**S01 (Keep-Alive):** Workspace stays alive 24h+ with no browser connected. Keep-alive failure shows warning banner after 3 consecutive failures.

**S02 (Reconnection):** WebSocket disconnect recovers automatically with infinite retries. Reconnecting banner visible during recovery. Tab switching never loses scrollback. Expired reconnectId creates new PTY on same tmux session.

**S03 (Scrollback Backend):** Terminal output written to Postgres in chunks. Scrollback survives proxy restart. Reconnect hydrates recent history from Postgres. Memory buffer handles Postgres outages gracefully.

**S04 (Virtual Scroll UI):** Scroll up through 10K+ lines without browser memory pressure. Lazy loading with skeleton placeholders. Jump-to-bottom button when scrolled away from live output.

**S05 (Integration):** Full lifecycle test: run process → close browser → wait → reopen → scrollback + process intact. All previous terminal features still work (multi-tab, rename, kill, session picker).

## Open Questions

- Exact Coder API endpoint for workspace activity bumps — needs research during S01 planning
- xterm.js addon or custom container for virtual scrolling — needs research during S04 planning
- Whether terminal-proxy should connect to Postgres directly or go through an API on the Next.js server — architecture decision for S03 planning
