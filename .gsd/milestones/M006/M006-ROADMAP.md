# M006: Persistent Terminal Sessions

## Vision
Fix critical terminal session persistence: server-side workspace keep-alive prevents Coder auto-stop, infinite WebSocket reconnection replaces the 10-attempt hard limit, Postgres-backed scrollback with virtual scrolling ensures terminal history survives browser close/reopen and persists for days. The user can run pnpm dev, close their browser, come back the next day, and find everything exactly as they left it.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | high | — | ✅ | Workspace stays alive for hours with no browser connected; terminal UI shows keep-alive status indicator and warning banner on failure |
| S02 | S02 | medium | — | ✅ | Disconnect network, reconnect — terminal resumes seamlessly with reconnecting banner, no manual refresh needed. Tab switching preserves all scrollback. |
| S03 | S03 | high | — | ✅ | Terminal output is written to Postgres in real-time chunks. Restart the terminal-proxy — reconnect and scrollback is restored from Postgres. |
| S04 | S04 | medium | — | ✅ | Scroll up through thousands of lines of persistent history with lazy loading. Close browser, reopen — full scrollback restored via virtual scroll from Postgres. |
| S05 | S05 | low | — | ⬜ | Run pnpm dev in tmux, close browser, come back next day — full scrollback visible, process still running. All previous terminal features still work. |
