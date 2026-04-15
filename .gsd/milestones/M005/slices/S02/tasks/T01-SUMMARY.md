---
id: T01
parent: S02
milestone: M005
key_files:
  - src/lib/terminal/protocol.ts
  - src/__tests__/lib/terminal/protocol.test.ts
  - package.json
key_decisions:
  - Omit zero/negative dimensions from encodeResize rather than sending them — avoids confusing the PTY server with invalid resize values
  - Use URLSearchParams for query string construction — handles encoding of the tmux command automatically
duration: 
verification_result: passed
completed_at: 2026-04-14T11:08:13.189Z
blocker_discovered: false
---

# T01: Add PTY WebSocket protocol encoder/decoder, URL builder with command-injection protection, and ws dependency

**Add PTY WebSocket protocol encoder/decoder, URL builder with command-injection protection, and ws dependency**

## What Happened

Created `src/lib/terminal/protocol.ts` with four pure functions forming the Coder PTY WebSocket protocol layer:\n\n- `encodeInput(data)` — serializes terminal input as JSON `{\"data\": \"...\"}`\n- `encodeResize(rows, cols)` — serializes resize commands as JSON `{\"height\": N, \"width\": N}`, omitting zero/negative dimensions\n- `decodeOutput(frame)` — type-narrows server frames: passes strings through, converts ArrayBuffer to Uint8Array\n- `buildPtyUrl(baseUrl, agentId, options)` — constructs the upstream Coder PTY WebSocket URL with protocol conversion (http→ws, https→wss), URL-encoded tmux command, and session name validation against `SAFE_IDENTIFIER_RE` to prevent command injection\n\nExported `PtyClientMessage` and `PtyConnectionOptions` TypeScript types for use by the proxy (T02) and client hook (T03).\n\nInstalled `ws@8.20.0` and `@types/ws@8.18.1` for the server-side WebSocket proxy.\n\nWrote 24 unit tests covering happy paths, special characters (unicode, quotes, newlines), boundary conditions (zero/negative dimensions, empty strings), and negative cases (shell metacharacters in session names: spaces, semicolons, backticks, pipes).

## Verification

All 24 tests pass via `pnpm vitest run src/__tests__/lib/terminal/protocol.test.ts`. `ws` dependency confirmed present in package.json via grep.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/terminal/protocol.test.ts` | 0 | ✅ pass — 24/24 tests passed | 158ms |
| 2 | `grep -q '"ws"' package.json` | 0 | ✅ pass — ws dependency present | 5ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/lib/terminal/protocol.ts`
- `src/__tests__/lib/terminal/protocol.test.ts`
- `package.json`
