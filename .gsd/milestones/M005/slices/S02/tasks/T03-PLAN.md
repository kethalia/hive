---
estimated_steps: 62
estimated_files: 5
skills_used: []
---

# T03: Build InteractiveTerminal component with WebSocket hook and auto-reconnect

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

## Inputs

- ``src/lib/terminal/protocol.ts` — encodeInput, encodeResize, decodeOutput from T01`
- ``src/components/templates/TerminalPanel.tsx` — reference for xterm.js dynamic import pattern and theme`
- ``src/lib/actions/workspaces.ts` — extend with getWorkspaceAgentAction`
- ``src/lib/coder/types.ts` — WorkspaceAgent type with id field`

## Expected Output

- ``src/hooks/useTerminalWebSocket.ts` — WebSocket hook with auto-reconnect`
- ``src/components/workspaces/InteractiveTerminal.tsx` — bidirectional xterm.js terminal component`
- ``src/app/workspaces/[id]/terminal/page.tsx` — dedicated terminal page`
- ``src/lib/actions/workspaces.ts` — extended with getWorkspaceAgentAction`
- ``src/__tests__/lib/terminal/hooks.test.ts` — backoff logic tests`

## Verification

pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts && pnpm build
