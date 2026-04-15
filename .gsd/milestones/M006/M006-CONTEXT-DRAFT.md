# M006: Persistent Terminal Sessions — Context Draft

**Gathered:** 2026-04-15
**Status:** Draft — depth verified, requirements confirmed, roadmap pending approval

## Problem Statement

Terminal sessions lose state after ~5 minutes of inactivity on a tab. User sees a fresh prompt with no scrollback when switching back. Running processes appear gone. Root cause is a three-layer failure:

1. Coder workspace auto-stop kills workspace when Hive stops sending activity (WebSocket reconnect gives up after 10 attempts)
2. Scrollback lives only in xterm.js browser memory — zero persistence
3. Reconnection creates fresh PTY attachments instead of restoring state

## User Requirement

"Nothing is closed automatically, never." Terminal sessions must persist for days. Close browser, come back next day, see full scrollback with processes still running.

## Scope

### In Scope
- Server-side keep-alive pings to Coder API, independent of browser state
- Infinite WebSocket reconnection (remove 10-attempt limit)
- Postgres-backed scrollback persistence with chunked writes
- Virtual scrolling for unlimited history
- Full scrollback hydration on reconnect/browser reopen
- Keep-alive failure warnings in UI
- Postgres write failure buffering (bounded ring buffer)

### Out of Scope
- Task workspace cleanup changes (separate system)
- Changes to Coder's PTY API itself

### Deferred
- Reconnection visual seam marker (timestamp in scrollback)

## Architecture Decisions

1. **Postgres over Redis for scrollback** — user wants persistence for days, Postgres survives restarts. Redis is in-memory and would lose data.
2. **Server-side keep-alive over browser-side** — must survive tab close and browser close. Browser-side pings die when tab is suspended.
3. **Infinite reconnection** — exponential backoff capped at 60s, never gives up. Visual banner with manual reconnect button.
4. **Virtual scrolling** — lazy-load chunks from Postgres on scroll-up, never load full history into browser memory.
5. **Bounded ring buffer** — terminal-proxy buffers PTY output in memory during Postgres outages, drops oldest on overflow.

## Error Handling Strategy

- **Postgres down during write:** Buffer in memory (bounded ring buffer ~50MB per session), retry with backoff, drop oldest on overflow. Terminal never blocked.
- **Postgres down during read:** Show terminal immediately, "History temporarily unavailable" banner, retry in background.
- **Keep-alive ping fails:** Retry every 30s, warn after 3 consecutive failures, never stop trying.
- **Workspace actually stops:** "Workspace stopped" state with "Restart" button, hydrate scrollback from Postgres on restart.
- **WebSocket drops:** Infinite reconnect with backoff. If reconnectId expired, new PTY on same tmux session.
- **Tab suspended by OS:** Server-side keep-alive handles it. On wake, reconnect and hydrate.
- **Browser closed:** Server-side keep-alive continues. Scrollback keeps writing to Postgres. On reopen, full hydration.
- **Duplicate chunks:** Sequence numbers with INSERT ON CONFLICT DO NOTHING.

## Quality Bar

- Workspace alive 24h+ without browser
- Scrollback survives browser close/reopen with full virtual scroll
- Infinite reconnection with no manual refresh
- Processes in tmux survive indefinitely
- Tab switching preserves all state
- Definition of done: run pnpm dev, close browser, come back next day, see full scrollback with process still running

## Technical Findings

### Coder API
- No deadline extension endpoint in current CoderClient — needs `PUT /api/v2/workspaces/{id}` with `ttl_ms`
- ai-dev template has no explicit TTL in Terraform, but Coder deployment may have default inactivity timeout
- Activity can be bumped via workspace API calls

### Terminal-Proxy
- Stateless WebSocket relay (services/terminal-proxy/)
- 30s upstream ping interval
- No scrollback buffering — output flows straight through
- Will need interception layer for Postgres writes

### Frontend
- xterm.js with 10,000 line scrollback in memory
- useTerminalWebSocket: 10 attempts max, exponential backoff to 30s
- reconnectId in localStorage with 24h TTL
- Tab switching uses display:none (keeps components mounted)
- No persistence layer whatsoever

### Database
- No terminal/session models in Prisma schema
- Need new tables for scrollback chunks and session tracking
