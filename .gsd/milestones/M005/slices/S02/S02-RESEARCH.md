# S02 Research: Bidirectional Terminal via PTY WebSocket

## Summary

Slice S02 must deliver a fully bidirectional interactive terminal rendered in-browser via xterm.js, connected to Coder workspace agents through their native PTY WebSocket endpoint (`/api/v2/workspaceagents/{id}/pty`). The Coder PTY protocol is asymmetric: the client sends JSON-encoded messages (`{ "data": "...", "height": N, "width": N }`) and the server responds with raw binary PTY output. All sessions must be tmux-backed per D019, meaning the `command` query parameter on the WebSocket URL will invoke `tmux new-session -A -s <name>` to attach-or-create. Reconnection after browser disconnect re-attaches to the same tmux session with full scrollback preserved.

The critical architectural decision is how to route WebSocket traffic. Next.js App Router route handlers do NOT support WebSocket upgrade — they only handle standard HTTP request/response cycles. There are three viable approaches: (A) a custom `server.ts` wrapping Next.js with `http.createServer` that intercepts `upgrade` events and proxies them to Coder, (B) connecting the browser directly to the Coder PTY WebSocket endpoint (bypassing Next.js entirely), or (C) using an `instrumentation.ts` hook to attach a WebSocket server to the underlying Node.js HTTP server. Per D018, the decision is to proxy through Next.js, which rules out option B and points toward option A or C. A custom server is the most battle-tested approach for WebSocket proxying in Next.js.

The existing codebase already has `@xterm/xterm` v6.0.0 and `@xterm/addon-fit` v0.11.0 installed. The existing `TerminalPanel.tsx` is write-only (output display for SSE push logs) and uses dynamic import with `ssr: false`. The new bidirectional terminal component will need a fundamentally different architecture: it must manage a WebSocket lifecycle, send user input via `terminal.onData()`, handle resize via `terminal.onResize()`, and write binary server output back to xterm. The `@xterm/addon-attach` package exists but is designed for simple text WebSockets — it won't work with Coder's asymmetric JSON-in/binary-out protocol, so a custom WebSocket handler is required.

## Recommendation

Build a custom `server.ts` that wraps Next.js and intercepts WebSocket upgrade requests on a specific path (e.g., `/api/terminal/ws`). This server-side proxy authenticates with Coder using the `CODER_SESSION_TOKEN`, opens an upstream WebSocket to `{CODER_URL}/api/v2/workspaceagents/{agentId}/pty?reconnect={reconnectId}&width={w}&height={h}&command={cmd}`, and bidirectionally pipes frames between the browser client and Coder. On the client side, build a new `InteractiveTerminal` component that manages the WebSocket connection, xterm.js lifecycle, input forwarding, resize events, and auto-reconnect with exponential backoff.

## Implementation Landscape

### Key Files to Create/Modify

| File | Purpose |
|------|---------|
| `server.ts` | Custom Node.js server wrapping Next.js; handles `upgrade` event for `/api/terminal/ws` path |
| `src/lib/terminal/proxy.ts` | WebSocket proxy logic: authenticate with Coder, open upstream PTY WS, pipe frames bidirectionally |
| `src/lib/terminal/protocol.ts` | Coder PTY protocol encoder/decoder: `encodeInput(data)`, `encodeResize(rows, cols)`, `decodeOutput(frame)` |
| `src/components/workspaces/InteractiveTerminal.tsx` | Client-side xterm.js + WebSocket component (dynamic import, ssr: false) |
| `src/hooks/useTerminalWebSocket.ts` | Custom hook: WebSocket lifecycle, auto-reconnect with exponential backoff, connection state |
| `src/components/workspaces/WorkspacesClient.tsx` | Modify: add "Connect" button per tmux session that opens InteractiveTerminal |
| `src/app/workspaces/[id]/terminal/page.tsx` | Optional: dedicated terminal page for a workspace (full-screen terminal) |
| `package.json` | Update dev/start scripts to use `server.ts`; add `ws` dependency |
| `next.config.ts` | No changes needed for WebSocket proxying via custom server |

### Coder PTY WebSocket Protocol

**Endpoint:** `GET /api/v2/workspaceagents/{agentId}/pty`

**Query Parameters:**
- `reconnect` — UUID v4 session ID (reuse to reattach to same PTY/tmux)
- `width` — initial terminal width (uint16)
- `height` — initial terminal height (uint16)
- `command` — shell command to execute (e.g., `tmux new-session -A -s hive-main`)

**Authentication:** `Coder-Session-Token: <token>` header on the WebSocket upgrade request.

**Client-to-Server (JSON text frames):**
```json
{ "data": "ls -la\r" }
```
```json
{ "height": 24, "width": 80 }
```
Fields are optional — a message with only `data` sends input; a message with only `height`/`width` resizes; both can coexist but typically don't. Zero-value height/width are ignored by the server.

**Server-to-Client (binary or text frames):**
Raw PTY output bytes. Write directly to xterm.js via `terminal.write(new Uint8Array(event.data))` for binary frames or `terminal.write(event.data)` for text frames.

### Build Order

1. **T01: Protocol layer** (`src/lib/terminal/protocol.ts`) — encode/decode functions, unit-tested
2. **T02: WebSocket proxy** (`server.ts` + `src/lib/terminal/proxy.ts`) — custom server with upgrade handler, upstream Coder WS connection, bidirectional frame piping
3. **T03: Client terminal component** (`InteractiveTerminal.tsx` + `useTerminalWebSocket.ts`) — xterm.js initialization, WebSocket connection, input/resize handling
4. **T04: Integration** — Wire InteractiveTerminal into WorkspacesClient, add tmux session connect buttons, add dedicated terminal page
5. **T05: Reconnection + offline detection** — Auto-reconnect with exponential backoff, workspace-offline detection (R042), tmux reattach on reconnect

### Verification Approach

- **Unit tests:** Protocol encoder/decoder functions, reconnect ID generation, tmux command construction
- **Integration test:** Custom server upgrade handler with mock upstream WebSocket
- **Manual E2E:** Connect to a real Coder workspace, type commands, verify output, resize terminal, disconnect/reconnect, verify tmux session persistence
- **Reconnection test:** Kill browser tab, reopen, verify scrollback preserved via tmux reattach

## Don't Hand-Roll

| Need | Library | Why |
|------|---------|-----|
| Server-side WebSocket | `ws` (npm) | De facto Node.js WebSocket library; handles upgrade, binary frames, ping/pong. Already compatible with Next.js custom server pattern. |
| Client-side WebSocket | Native `WebSocket` API | No library needed; browser-native. Wrap in custom hook for reconnect logic. |
| Terminal emulator | `@xterm/xterm` v6.0.0 | Already installed. |
| Terminal fit | `@xterm/addon-fit` v0.11.0 | Already installed. |
| Terminal web links | `@xterm/addon-web-links` v0.12.0 | Nice-to-have: makes URLs clickable in terminal output. |
| UUID generation | `uuid` (npm) | Already installed; use for reconnect session IDs. |
| Exponential backoff | Hand-roll (simple) | 10 lines of code; no library needed for `min(baseDelay * 2^attempt, maxDelay)` |

**Do NOT use:**
- `@xterm/addon-attach` — designed for simple text WebSockets, incompatible with Coder's asymmetric protocol
- `socket.io` — unnecessary overhead; raw `ws` + native WebSocket is simpler and matches Coder's protocol
- `http-proxy` / `http-proxy-middleware` — designed for HTTP, not WebSocket binary frame proxying with protocol translation

## Constraints

1. **Next.js App Router cannot do WebSocket upgrade** — route handlers return `Response` objects; there is no access to the raw Node.js `socket` needed for `upgrade`. A custom `server.ts` is mandatory.
2. **Dev script change** — `package.json` dev/start scripts must change from `next dev` to `tsx server.ts` (or similar). This affects DX for the entire team.
3. **Coder session token is server-side only** — The `CODER_SESSION_TOKEN` env var must never reach the browser. The proxy authenticates on behalf of the client.
4. **Binary frame handling** — The proxy must forward binary frames from Coder to the browser without re-encoding. Use `ws` with `{ binary: true }` option.
5. **tmux command injection** — The `command` parameter and session name must be sanitized against shell injection. Use the existing `SAFE_IDENTIFIER_RE` from constants.
6. **Single Coder agent assumption** — The current codebase assumes agent name "main" in `WorkspacesClient.tsx`. The terminal proxy needs the actual agent ID (UUID), which requires resolving it from workspace resources.

## Common Pitfalls

1. **Forgetting to forward binary frames as binary.** The `ws` library defaults to auto-detecting frame type, but if you use `JSON.stringify` anywhere in the output path, binary PTY output gets corrupted. Always check `typeof event.data` and forward accordingly.

2. **Not handling WebSocket close/error on both sides.** When the browser disconnects, the upstream Coder WebSocket must also be closed (and vice versa). Failure to do this leaks connections and tmux sessions.

3. **Resize race condition.** The FitAddon computes dimensions after DOM mount, but the WebSocket may not be open yet. Queue the initial resize and send it once the WebSocket opens.

4. **xterm.js SSR crash.** xterm.js accesses `window` and `document` on import. Must use `dynamic(() => import(...), { ssr: false })` or guard with `useEffect` + dynamic `import()` as the existing `TerminalPanel` does.

5. **Custom server breaks `next dev --turbopack` hot reload.** When using a custom server, Turbopack HMR WebSocket connections must be excluded from the proxy's upgrade handler. Only intercept the specific terminal path.

6. **Reconnect ID reuse across tabs.** Each browser tab must generate its own reconnect UUID. Sharing a reconnect ID between tabs causes both to fight over the same PTY, producing garbled output.

7. **Missing ping/pong keepalive.** WebSocket connections through proxies/load balancers may be terminated after idle timeout. Implement ping/pong on the server-side proxy to keep connections alive.

8. **Terminal font loading.** xterm.js renders incorrectly if the specified font hasn't loaded yet. Use `document.fonts.ready` or a short delay before calling `fit()`.

## Open Risks

1. **Custom server DX impact (MEDIUM).** Switching from `next dev` to a custom server changes the development workflow. Hot reload still works but Turbopack integration needs testing. Mitigation: test thoroughly before merging; document the new dev command.

2. **WebSocket connection limits (LOW).** Each open terminal is two WebSocket connections (browser-to-proxy, proxy-to-Coder). Under heavy use with many terminals, this could strain the server. Mitigation: implement connection limits and idle timeout.

3. **Coder API stability (LOW).** The PTY WebSocket protocol is not formally versioned. Coder could change the `ReconnectingPTYRequest` format. Mitigation: isolate protocol handling in `protocol.ts` so changes are localized.

4. **tmux session cleanup (MEDIUM).** If a user opens many terminals and never closes them, orphaned tmux sessions accumulate on the workspace. Mitigation: add session listing/cleanup UI in a future slice; set tmux `destroy-unattached` option with a grace period.

5. **Authentication token expiry (LOW).** If the `CODER_SESSION_TOKEN` expires mid-session, the upstream WebSocket will be terminated. Mitigation: handle upstream close gracefully and surface an error to the user.
