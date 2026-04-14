---
id: T02
parent: S02
milestone: M005
key_files:
  - server.ts
  - src/lib/terminal/proxy.ts
  - src/__tests__/lib/terminal/proxy.test.ts
  - package.json
key_decisions:
  - Use Next.js getUpgradeHandler() for non-terminal WebSocket upgrades — cleanly separates HMR from terminal traffic without path-matching fragility
  - Use ws WebSocketServer in noServer mode — handleUpgrade receives the raw socket from the HTTP server, avoiding port conflicts
duration: 
verification_result: passed
completed_at: 2026-04-14T11:11:03.906Z
blocker_discovered: false
---

# T02: Create custom server.ts with WebSocket upgrade proxy to Coder PTY endpoint, bidirectional frame forwarding, and keepalive

**Create custom server.ts with WebSocket upgrade proxy to Coder PTY endpoint, bidirectional frame forwarding, and keepalive**

## What Happened

Created `src/lib/terminal/proxy.ts` — the server-side WebSocket proxy that bridges browser clients to Coder workspace PTY endpoints. The `handleUpgrade` function validates query params (agentId as UUID, sessionName against SAFE_IDENTIFIER_RE), reads `CODER_SESSION_TOKEN` from env (never from client), builds the upstream PTY URL via `buildPtyUrl` from T01, and opens an authenticated upstream WebSocket with `Coder-Session-Token` header. Frames are forwarded bidirectionally preserving binary encoding — upstream binary/text frames pass through to browser as-is, browser messages forward to upstream. A 30-second ping interval prevents proxy idle timeouts. Both sides are cleaned up on disconnect/error to prevent connection leaks. Upstream connect timeout is 10s, closing the browser WS with code 1013 on timeout and 1011 on error.

Created `server.ts` at project root — a custom Node.js HTTP server wrapping Next.js. It intercepts only `/api/terminal/ws` upgrade requests, delegating all other upgrades (including HMR) to Next.js via `app.getUpgradeHandler()`. Port/hostname read from env with sensible defaults (0.0.0.0:3000). Development mode detected via NODE_ENV.

Updated `package.json` dev script to `tsx watch server.ts` and start script to `NODE_ENV=production node server.js`. Added `tsx` as explicit devDependency (v4.21.0).

Wrote 12 unit tests covering: missing token (401), missing params (400), invalid UUID agentId, unsafe session names (semicolons, spaces, backticks), token sourced from env not query, correct upstream URL and auth header, handshake timeout, UUID case-insensitivity, and default sessionName fallback.

## Verification

All 12 proxy tests pass via `pnpm vitest run src/__tests__/lib/terminal/proxy.test.ts`. `pnpm build` succeeds — custom server.ts doesn't interfere with Next.js build. `grep -q 'server.ts' package.json` confirms dev script references the custom server.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/terminal/proxy.test.ts` | 0 | ✅ pass — 12/12 tests passed | 184ms |
| 2 | `pnpm build` | 0 | ✅ pass — Next.js build completes with all routes | 8000ms |
| 3 | `grep -q 'server.ts' package.json` | 0 | ✅ pass — dev script references custom server | 5ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `server.ts`
- `src/lib/terminal/proxy.ts`
- `src/__tests__/lib/terminal/proxy.test.ts`
- `package.json`
