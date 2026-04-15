---
estimated_steps: 20
estimated_files: 4
skills_used: []
---

# T02: Add keep-alive polling hook and warning banner to terminal UI

## Description

Create a React hook that polls the terminal-proxy's `/keepalive/status` endpoint and a warning banner component that renders when consecutive failures reach the threshold. The hook polls every 30 seconds and exposes per-workspace status. The banner uses shadcn's Alert component with the `destructive` variant, matching the existing pattern in InteractiveTerminal.tsx. Mount the banner in TerminalTabManager above the terminal tabs.

Also update the WebSocket connection URL construction to include `workspaceId` as a query parameter so the proxy can track which workspaces have active sessions.

## Steps

1. Find where the terminal WebSocket URL is constructed (likely in `useTerminalWebSocket` or the component that calls it) and add `workspaceId` as a query parameter to the connection URL.
2. Create `src/hooks/useKeepAliveStatus.ts`: a hook that accepts `workspaceId` and the terminal-proxy base URL, polls `GET {proxyUrl}/keepalive/status` every 30s via `fetch`, extracts the workspace's entry from the response, and returns `{consecutiveFailures: number, lastSuccess: string | null, lastFailure: string | null, isLoading: boolean}`. Use `useEffect` with `setInterval` pattern matching existing hooks. Clean up interval on unmount.
3. Create `src/components/workspaces/KeepAliveWarning.tsx`: accepts `workspaceId` prop, calls `useKeepAliveStatus`, renders nothing when `consecutiveFailures < 3`, renders shadcn `Alert` with `variant="destructive"` when `consecutiveFailures >= 3`. Message: "Keep-alive service cannot reach Coder API ({consecutiveFailures} consecutive failures). Your workspace may auto-stop if this continues." Include AlertTitle and AlertDescription.
4. Mount `KeepAliveWarning` in `src/components/workspaces/TerminalTabManager.tsx` above the terminal tab bar, passing the `workspaceId` prop.

## Must-Haves

- [ ] WebSocket connection URL includes `workspaceId` query parameter
- [ ] useKeepAliveStatus hook polls /keepalive/status every 30s, returns per-workspace failure data
- [ ] KeepAliveWarning renders nothing when consecutiveFailures < 3
- [ ] KeepAliveWarning renders destructive Alert banner when consecutiveFailures >= 3
- [ ] Uses shadcn Alert component (not custom HTML)
- [ ] Hook cleans up interval on unmount

## Verification

- `grep -q 'useKeepAliveStatus' src/hooks/useKeepAliveStatus.ts` — hook file exists
- `grep -q 'KeepAliveWarning' src/components/workspaces/TerminalTabManager.tsx` — banner mounted in tab manager
- `grep -q 'workspaceId' src/hooks/useTerminalWebSocket.ts || grep -rq 'workspaceId.*ws' src/components/workspaces/` — workspaceId passed in WebSocket URL
- `pnpm tsc --noEmit` — no TypeScript errors

## Inputs

- ``services/terminal-proxy/src/keepalive.ts` — T01 output defining the /keepalive/status response shape`
- ``services/terminal-proxy/src/index.ts` — T01 output with /keepalive/status endpoint`
- ``src/components/workspaces/TerminalTabManager.tsx` — existing tab manager with agentId and workspaceId props, connection state tracking`
- ``src/hooks/useTerminalWebSocket.ts` — existing WebSocket hook with URL construction and connection state management`
- ``src/components/ui/alert.tsx` — shadcn Alert component with destructive variant`

## Expected Output

- ``src/hooks/useKeepAliveStatus.ts` — new polling hook for keep-alive status`
- ``src/components/workspaces/KeepAliveWarning.tsx` — new warning banner component using shadcn Alert destructive variant`
- ``src/components/workspaces/TerminalTabManager.tsx` — modified to mount KeepAliveWarning above tab bar`
- ``src/hooks/useTerminalWebSocket.ts` — modified to include workspaceId in WebSocket connection URL`

## Verification

pnpm tsc --noEmit && grep -q 'KeepAliveWarning' src/components/workspaces/TerminalTabManager.tsx
