---
estimated_steps: 37
estimated_files: 3
skills_used: []
---

# T01: Build PTY protocol encoder/decoder and install ws dependency

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

## Inputs

- ``src/lib/constants.ts` — SAFE_IDENTIFIER_RE for session name validation`
- ``package.json` — add ws dependency`

## Expected Output

- ``src/lib/terminal/protocol.ts` — protocol encoder/decoder and URL builder`
- ``src/__tests__/lib/terminal/protocol.test.ts` — unit tests for protocol layer`
- ``package.json` — updated with ws and @types/ws dependencies`

## Verification

pnpm vitest run src/__tests__/lib/terminal/protocol.test.ts
