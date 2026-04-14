# S02: Bidirectional Terminal via PTY WebSocket

**Goal:** Deliver a fully bidirectional interactive terminal in-browser via xterm.js, connected to Coder workspace agents through their native PTY WebSocket endpoint, with all sessions tmux-backed for persistence and auto-reconnect on network interruption.
**Demo:** User clicks 'new terminal' on a workspace, gets a full interactive shell — types commands, runs vim, closes the tab, reopens it, reattaches to the same tmux session with scrollback intact

## Must-Haves

- `pnpm vitest run src/__tests__/lib/terminal/` passes all protocol and proxy tests
- `pnpm build` succeeds with custom server entry point
- Custom server handles WebSocket upgrade on `/api/terminal/ws` path
- InteractiveTerminal component renders xterm.js and connects via WebSocket
- All terminal sessions use tmux (D019) — reconnect reattaches with scrollback
- Auto-reconnect with exponential backoff on network interruption (R042)
- CODER_SESSION_TOKEN never reaches the browser — proxy authenticates server-side
- Workspace-offline state shown in UI when agent is not connected

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (Coder workspace needed for E2E, but unit/integration tests cover protocol and proxy logic)
- Human/UAT required: yes (interactive terminal UX must be manually verified)

## Integration Closure

- Upstream surfaces consumed: `src/lib/coder/types.ts` (WorkspaceAgent.id for PTY endpoint), `src/lib/actions/workspaces.ts` (workspace listing), `src/lib/workspaces/sessions.ts` (TmuxSession type), `src/lib/constants.ts` (SAFE_IDENTIFIER_RE)
- New wiring introduced: `server.ts` custom Node.js server wrapping Next.js; `/api/terminal/ws` WebSocket upgrade path; `InteractiveTerminal` component in workspace UI
- What remains before milestone is truly usable end-to-end: S03 (multi-tab terminal management), S04 (external tool integration)

## Verification

- Runtime signals: WebSocket connection state transitions logged to console (connecting → connected → disconnected → reconnecting), upstream proxy errors logged server-side with workspace/agent context
- Inspection surfaces: Browser console shows connection state; server logs show upstream WebSocket lifecycle; terminal UI shows connection status badge
- Failure visibility: Connection error message in terminal UI, reconnect attempt count, last error reason, workspace-offline detection
- Redaction constraints: CODER_SESSION_TOKEN must never appear in client-side logs or error messages

## Tasks

- [x] **T01: Build PTY protocol encoder/decoder and install ws dependency** `est:30m`
  Create the Coder PTY WebSocket protocol layer — pure functions for encoding client-to-server messages (input data, resize commands) and decoding server-to-client frames. Install the `ws` npm package needed by the server-side proxy. This is the foundational contract that both the proxy (T02) and client hook (T03) depend on.

The Coder PTY protocol is asymmetric: client sends JSON text frames with optional `data` (string) and `height`/`width` (uint16) fields. Server responds with raw binary PTY output. The encoder must produce valid JSON text frames. The decoder is trivial (pass-through binary) but should handle both binary ArrayBuffer and text string frames.

Also create a `buildPtyUrl` helper that constructs the upstream Coder PTY WebSocket URL from agent ID, reconnect UUID, dimensions, and tmux command — with input sanitization using `SAFE_IDENTIFIER_RE` from `src/lib/constants.ts` to prevent command injection in session names.

## Steps

1. Run `pnpm add ws` and `pnpm add -D @types/ws` to install the WebSocket library
2. Create `src/lib/terminal/protocol.ts` with:
   - `encodeInput(data: string): string` — returns JSON `{"data": "..."}`
   - `encodeResize(rows: number, cols: number): string` — returns JSON `{"height": N, "width": N}`
   - `decodeOutput(frame: ArrayBuffer | string): Uint8Array | string` — pass-through with type narrowing
   - `buildPtyUrl(baseUrl: string, agentId: string, options: { reconnectId: string, width: number, height: number, sessionName: string }): string` — constructs `wss://host/api/v2/workspaceagents/{agentId}/pty?reconnect=...&width=...&height=...&command=tmux+new-session+-A+-s+{name}`
   - Validate `sessionName` against `SAFE_IDENTIFIER_RE`, throw on invalid input
   - Export `PtyClientMessage` and `PtyConnectionOptions` TypeScript types
3. Create `src/__tests__/lib/terminal/protocol.test.ts` with tests:
   - `encodeInput` produces valid JSON with data field
   - `encodeInput` handles special characters (newlines, quotes, unicode)
   - `encodeResize` produces valid JSON with height/width fields
   - `encodeResize` ignores zero values (returns empty JSON or omits zero fields)
   - `decodeOutput` passes through ArrayBuffer as Uint8Array
   - `decodeOutput` passes through string as-is
   - `buildPtyUrl` constructs correct URL with all parameters
   - `buildPtyUrl` converts http:// base URL to ws:// and https:// to wss://
   - `buildPtyUrl` rejects session names with shell metacharacters
   - `buildPtyUrl` URL-encodes the tmux command
4. Run `pnpm vitest run src/__tests__/lib/terminal/protocol.test.ts` — all tests pass

## Must-Haves

- [ ] `ws` and `@types/ws` installed in package.json
- [ ] All encode/decode functions are pure (no side effects, no I/O)
- [ ] `buildPtyUrl` validates session name against SAFE_IDENTIFIER_RE
- [ ] Protocol types exported for use by proxy and client hook
- [ ] All tests pass

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/protocol.test.ts` — all tests pass
- `grep -q '"ws"' package.json` — ws dependency present

## Negative Tests

- **Malformed inputs**: empty string to encodeInput, zero/negative dimensions to encodeResize, empty session name to buildPtyUrl
- **Boundary conditions**: session name with spaces/semicolons/backticks rejected by SAFE_IDENTIFIER_RE
- **Error paths**: buildPtyUrl throws on invalid session name (not silent failure)
  - Files: `src/lib/terminal/protocol.ts`, `src/__tests__/lib/terminal/protocol.test.ts`, `package.json`
  - Verify: pnpm vitest run src/__tests__/lib/terminal/protocol.test.ts

- [x] **T02: Create custom server.ts with WebSocket upgrade proxy to Coder PTY** `est:1h`
  Build the server-side WebSocket proxy — the critical infrastructure that routes terminal traffic between browser clients and Coder workspace agents. This task creates `server.ts` (custom Node.js HTTP server wrapping Next.js) and `src/lib/terminal/proxy.ts` (upstream WebSocket connection manager).

Next.js App Router route handlers cannot do WebSocket upgrade (they return Response objects, no access to raw socket). A custom `server.ts` is mandatory per the research findings. The server intercepts HTTP upgrade requests on `/api/terminal/ws`, authenticates with Coder using `CODER_SESSION_TOKEN`, opens an upstream WebSocket to the Coder PTY endpoint, and pipes frames bidirectionally.

Critical constraints:
- Must NOT intercept Next.js HMR WebSocket upgrades (only handle `/api/terminal/ws` path)
- Must forward binary frames from Coder as binary (not re-encoded as text)
- Must close upstream WebSocket when browser disconnects (and vice versa) to prevent connection leaks
- Must implement ping/pong keepalive to prevent proxy/load-balancer idle timeout
- CODER_SESSION_TOKEN is server-side only — never forwarded to browser

## Steps

1. Create `src/lib/terminal/proxy.ts` with:
   - `handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void` — validates query params (agentId, reconnectId, width, height, sessionName), builds upstream Coder PTY URL using `buildPtyUrl` from protocol.ts, opens upstream `ws.WebSocket` with `Coder-Session-Token` header, pipes frames bidirectionally
   - On browser message: parse as JSON, forward to upstream (client sends JSON text frames)
   - On upstream message: forward raw binary/text frame to browser (server sends raw PTY output)
   - On either side close/error: close the other side, clean up
   - Implement 30-second ping interval on upstream connection
   - Validate agentId is UUID format, sessionName against SAFE_IDENTIFIER_RE
   - Log connection lifecycle events (connect, disconnect, error) with agentId context, never log token
2. Create `server.ts` at project root:
   - Import Next.js via `next()`, prepare it, get request handler
   - Create `http.createServer(handler)` for normal HTTP
   - Listen on `server.on('upgrade', ...)` — if path starts with `/api/terminal/ws`, delegate to `handleUpgrade` from proxy.ts; otherwise let Next.js handle it (HMR WebSockets)
   - Read port from `PORT` env var (default 3000) and hostname from `HOSTNAME` (default '0.0.0.0')
   - In development mode (`NODE_ENV !== 'production'`), pass `dev: true` to next()
3. Update `package.json` scripts:
   - `"dev": "tsx watch server.ts"` (tsx already in devDeps as transitive dep of vitest — verify, install if needed)
   - `"start": "NODE_ENV=production node server.js"` (built output)
   - Keep `"build": "next build"` unchanged
   - Add `"server:build": "tsx server.ts"` or handle via next build output
4. Create `src/__tests__/lib/terminal/proxy.test.ts` with:
   - Test that handleUpgrade rejects requests missing required params (agentId, reconnectId)
   - Test that handleUpgrade rejects invalid agentId (not UUID format)
   - Test that handleUpgrade rejects unsafe session names
   - Test that CODER_SESSION_TOKEN is read from process.env (not from query params)
   - Mock ws.WebSocket to verify upstream connection is opened with correct URL and auth header
5. Verify `pnpm build` still succeeds (custom server doesn't break Next.js build)
6. Run `pnpm vitest run src/__tests__/lib/terminal/proxy.test.ts` — all tests pass

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Coder PTY WebSocket | Close browser WS with 1011 (unexpected condition), log error | 10s connection timeout, close browser WS with 1013 (try again later) | Forward raw bytes anyway (PTY output is opaque) |
| CODER_SESSION_TOKEN env | Reject upgrade with 401, log missing token | N/A | N/A |

## Must-Haves

- [ ] Custom server.ts wraps Next.js and handles both HTTP and WebSocket upgrade
- [ ] Only `/api/terminal/ws` path is intercepted — all other upgrades pass through to Next.js
- [ ] Upstream Coder WebSocket authenticated via Coder-Session-Token header
- [ ] Binary frames forwarded as binary (not re-encoded)
- [ ] Both sides cleaned up on disconnect (no connection leaks)
- [ ] Ping/pong keepalive on upstream connection
- [ ] package.json dev script uses custom server
- [ ] All proxy tests pass

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/proxy.test.ts` — all tests pass
- `pnpm build` succeeds
- `grep -q 'server.ts' package.json` — dev script references custom server

## Observability Impact

- Signals added: console.log for WebSocket connection lifecycle (connect, disconnect, error) with agentId
- How a future agent inspects this: server stdout/stderr logs
- Failure state exposed: connection error reason, upstream close code
  - Files: `server.ts`, `src/lib/terminal/proxy.ts`, `src/__tests__/lib/terminal/proxy.test.ts`, `package.json`
  - Verify: pnpm vitest run src/__tests__/lib/terminal/proxy.test.ts && pnpm build

- [x] **T03: Build InteractiveTerminal component with WebSocket hook and auto-reconnect** `est:1h15m`
  Create the client-side interactive terminal — an xterm.js component connected via WebSocket to the proxy from T02, with auto-reconnect and exponential backoff for network resilience (R042). This delivers R036 (bidirectional terminal) and R037 (tmux-backed sessions) from the browser side.

The component architecture follows the existing TerminalPanel.tsx pattern (dynamic import, ssr: false, same theme) but is fundamentally different: it manages a WebSocket lifecycle, sends user input via `terminal.onData()`, handles resize via `terminal.onResize()` with FitAddon, and writes raw server output back to xterm. A custom `useTerminalWebSocket` hook encapsulates WebSocket lifecycle, reconnection, and connection state.

Key constraints from research:
- xterm.js must be dynamically imported (accesses window/document on import)
- Each browser tab must generate its own reconnect UUID (sharing causes garbled output)
- Resize must be queued until WebSocket is open (FitAddon computes dimensions after DOM mount)
- Use `document.fonts.ready` before first `fit()` to prevent incorrect rendering
- Reconnect reuses the same reconnect UUID to reattach to the same tmux session (D019)

## Steps

1. Create `src/hooks/useTerminalWebSocket.ts`:
   - Props: `{ url: string, onData: (data: Uint8Array | string) => void, onStateChange: (state: ConnectionState) => void }`
   - `ConnectionState` type: `'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed' | 'workspace-offline'`
   - Opens WebSocket to the proxy URL (`/api/terminal/ws?agentId=...&reconnectId=...&width=...&height=...&sessionName=...`)
   - Exposes `send(data: string)` for input and `resize(rows: number, cols: number)` for resize
   - Auto-reconnect with exponential backoff: base 1s, max 30s, factor 2, jitter ±500ms
   - Max reconnect attempts: 10, then transition to 'failed' state
   - On upstream close with code 4404 (or similar workspace-offline indicator): transition to 'workspace-offline' state, stop reconnecting
   - Cleanup on unmount: close WebSocket, cancel reconnect timer
2. Create `src/components/workspaces/InteractiveTerminal.tsx`:
   - Props: `{ agentId: string, sessionName: string, coderUrl: string, className?: string }`
   - Generate reconnect UUID once on mount using `crypto.randomUUID()` (or `uuid.v4()`)
   - Dynamic import of xterm.js and FitAddon in useEffect (same pattern as TerminalPanel.tsx)
   - Wait for `document.fonts.ready` before first `fit()` call
   - Wire `terminal.onData(data => ws.send(encodeInput(data)))` for user input
   - Wire `terminal.onResize(({ rows, cols }) => ws.send(encodeResize(rows, cols)))` for resize
   - Wire `ws.onData(frame => terminal.write(frame))` for server output
   - Queue initial resize until WebSocket is connected
   - Show connection state indicator: green dot for connected, yellow for connecting/reconnecting, red for failed
   - Show "Workspace offline" message when in workspace-offline state
   - Reuse TerminalPanel.tsx theme (Dracula-like) and font settings for consistency
   - Handle window resize → FitAddon.fit() → send resize message
   - Dispose terminal and close WebSocket on unmount
3. Create `src/app/workspaces/[id]/terminal/page.tsx`:
   - Server component that reads workspace ID from params
   - Calls a server action to resolve workspace agent ID from workspace ID
   - Create `getWorkspaceAgentAction` in `src/lib/actions/workspaces.ts` — fetches workspace resources, finds first agent, returns agent ID
   - Renders InteractiveTerminal with dynamic import (ssr: false)
   - Default session name: `hive-main`
4. Create `src/__tests__/lib/terminal/hooks.test.ts`:
   - Test reconnect backoff calculation (exponential with jitter)
   - Test max reconnect attempts transitions to 'failed'
   - Test cleanup cancels reconnect timer
   - Note: Full WebSocket integration test requires browser environment — unit test the backoff logic as pure functions extracted from the hook

## Must-Haves

- [ ] InteractiveTerminal renders xterm.js with bidirectional I/O (R036)
- [ ] User keystrokes sent via WebSocket as JSON-encoded input
- [ ] Server PTY output written to xterm (binary and text frames)
- [ ] Terminal resize events sent to server
- [ ] Auto-reconnect with exponential backoff on disconnect (R042)
- [ ] Same reconnect UUID reused to reattach tmux session (R037)
- [ ] Workspace-offline detection with clear UI state (R042)
- [ ] Connection state indicator visible to user
- [ ] xterm.js dynamically imported (no SSR crash)
- [ ] Terminal page at /workspaces/[id]/terminal

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts` — backoff logic tests pass
- `pnpm build` succeeds with terminal page route
- `grep -rq 'InteractiveTerminal' src/app/workspaces/` — component wired into page

## Observability Impact

- Signals added: connection state transitions logged to browser console, reconnect attempt count
- How a future agent inspects this: browser devtools console, connection state badge in UI
- Failure state exposed: 'failed' and 'workspace-offline' states visible in UI
  - Files: `src/hooks/useTerminalWebSocket.ts`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/app/workspaces/[id]/terminal/page.tsx`, `src/lib/actions/workspaces.ts`, `src/__tests__/lib/terminal/hooks.test.ts`
  - Verify: pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts && pnpm build

- [x] **T04: Wire terminal connect buttons into workspace list and verify full integration** `est:30m`
  Connect the InteractiveTerminal into the existing workspace UI — add 'New Terminal' and per-session 'Connect' buttons to WorkspacesClient.tsx, wire them to navigate to the terminal page, and run full verification across the slice.

This task closes the integration loop: after T01-T03, the terminal infrastructure exists but isn't accessible from the workspace listing page. Users need to click a button on a workspace card to open a terminal session.

## Steps

1. Modify `src/components/workspaces/WorkspacesClient.tsx`:
   - Add a 'New Terminal' button on each running workspace card (next to existing Filebrowser/KasmVNC/Dashboard buttons)
   - The button navigates to `/workspaces/{workspaceId}/terminal` (using Next.js router)
   - Add per-tmux-session 'Connect' buttons in the expanded session panel that navigate to `/workspaces/{workspaceId}/terminal?session={sessionName}`
   - Disable terminal buttons for non-running workspaces (agent must be connected)
   - Use Terminal icon from lucide-react (already imported in WorkspacesClient.tsx)
2. Update `src/app/workspaces/[id]/terminal/page.tsx` to read optional `session` search param:
   - If `session` query param provided, use it as tmux session name
   - If not provided, default to `hive-main`
3. Run full slice verification:
   - `pnpm vitest run src/__tests__/lib/terminal/` — all protocol, proxy, and hook tests pass
   - `pnpm vitest run` — full test suite passes, zero regressions
   - `pnpm build` — succeeds with all new routes
   - Verify CODER_SESSION_TOKEN doesn't appear in any client component: `grep -rn 'CODER_SESSION_TOKEN' src/components/ src/hooks/ src/app/` should only match server components/actions

## Must-Haves

- [ ] 'New Terminal' button visible on running workspace cards
- [ ] Per-session 'Connect' buttons in expanded tmux session panel
- [ ] Terminal buttons disabled for non-running workspaces
- [ ] Session name passed via URL query parameter
- [ ] Full test suite passes with zero regressions
- [ ] CODER_SESSION_TOKEN not in any client-side code

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/` — all terminal tests pass
- `pnpm vitest run` — full suite passes (331+ tests, zero failures)
- `pnpm build` — succeeds
- `! grep -rn 'CODER_SESSION_TOKEN' src/components/ src/hooks/` — no matches (token is server-side only)
  - Files: `src/components/workspaces/WorkspacesClient.tsx`, `src/app/workspaces/[id]/terminal/page.tsx`
  - Verify: pnpm vitest run && pnpm build

## Files Likely Touched

- src/lib/terminal/protocol.ts
- src/__tests__/lib/terminal/protocol.test.ts
- package.json
- server.ts
- src/lib/terminal/proxy.ts
- src/__tests__/lib/terminal/proxy.test.ts
- src/hooks/useTerminalWebSocket.ts
- src/components/workspaces/InteractiveTerminal.tsx
- src/app/workspaces/[id]/terminal/page.tsx
- src/lib/actions/workspaces.ts
- src/__tests__/lib/terminal/hooks.test.ts
- src/components/workspaces/WorkspacesClient.tsx
