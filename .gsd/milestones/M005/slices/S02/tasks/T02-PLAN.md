---
estimated_steps: 58
estimated_files: 4
skills_used: []
---

# T02: Create custom server.ts with WebSocket upgrade proxy to Coder PTY

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

## Inputs

- ``src/lib/terminal/protocol.ts` — buildPtyUrl and protocol types from T01`
- ``src/lib/constants.ts` — SAFE_IDENTIFIER_RE`
- ``package.json` — update dev/start scripts`

## Expected Output

- ``server.ts` — custom Node.js server wrapping Next.js with WebSocket upgrade handler`
- ``src/lib/terminal/proxy.ts` — WebSocket proxy connecting browser to Coder PTY endpoint`
- ``src/__tests__/lib/terminal/proxy.test.ts` — proxy unit tests`
- ``package.json` — updated dev/start scripts to use custom server`

## Verification

pnpm vitest run src/__tests__/lib/terminal/proxy.test.ts && pnpm build
