# S01 Research: Workspace Keep-Alive Service

## Summary

The Workspace Keep-Alive Service needs to run server-side, periodically pinging the Coder API to prevent workspace auto-stop while terminal sessions are active. The Coder API provides a `PUT /api/v2/workspaces/{workspace}/extend` endpoint that accepts a JSON body with a `deadline` field (ISO 8601 timestamp) to push out the auto-stop deadline. Authentication uses the existing `Coder-Session-Token` header. The `CoderClient` class at `src/lib/coder/client.ts` already wraps authenticated fetch calls to the Coder API and provides workspace lookup methods — adding an `extendWorkspace` method is straightforward.

The main architectural question is where to run the keep-alive loop. There is no custom `server.ts` — the app uses standard `next dev` / `next start` (see `package.json` scripts). The terminal-proxy is a separate Node.js HTTP server (`services/terminal-proxy/src/index.ts`) that handles WebSocket upgrades. The keep-alive service could live in either place: (a) as a Next.js API route with a cron/interval scheduler, (b) as a standalone service alongside the terminal-proxy, or (c) integrated into the terminal-proxy itself since it already knows which agents have active connections. Option (c) is the most natural fit — the proxy already tracks upstream WebSocket connections per agent, so it knows exactly which workspaces have active sessions without needing a separate tracking mechanism.

For the UI warning banner (R050), the existing `Alert` component from shadcn (`src/components/ui/alert.tsx`) with the `destructive` variant is the right pattern. The `InteractiveTerminal.tsx` already uses `Alert` for connection state warnings. The keep-alive status needs to flow from the server to the frontend — either via a dedicated API endpoint that the frontend polls, or via a status message injected into the terminal WebSocket protocol. A lightweight polling endpoint (`GET /api/keep-alive/status?workspaceId=X`) is simpler and decoupled from the terminal data stream.

## Recommendation

Build the keep-alive service inside the terminal-proxy process. It already maintains WebSocket connections per agent and knows which workspaces are active. Add an `extendWorkspace` method to `CoderClient`, instantiate a keep-alive manager in the proxy that pings every 30-60 seconds for each workspace with at least one active connection, track consecutive failures per workspace, and expose a `/keepalive/status` HTTP endpoint on the proxy's existing HTTP server. The Next.js frontend polls this endpoint and renders a destructive Alert banner when `consecutiveFailures >= 3`.

## Implementation Landscape

### Key Files

| File | Role | Change Needed |
|------|------|---------------|
| `src/lib/coder/client.ts` | Coder API client | Add `extendWorkspace(workspaceId: string, deadlineMinutes?: number)` method using `PUT /api/v2/workspaces/{id}/extend` |
| `src/lib/coder/types.ts` | Coder API types | Add `ExtendWorkspaceRequest` interface with `deadline: string` field |
| `services/terminal-proxy/src/proxy.ts` | WebSocket proxy | Export a registry of active agent connections (Map of agentId -> connection count) for keep-alive to consume |
| `services/terminal-proxy/src/index.ts` | Proxy HTTP server | Initialize KeepAliveManager on startup; add `/keepalive/status` HTTP endpoint |
| `services/terminal-proxy/src/keepalive.ts` | **NEW** Keep-alive manager | Core service: interval timer, per-workspace failure tracking, Coder API calls |
| `src/hooks/useKeepAliveStatus.ts` | **NEW** Frontend hook | Poll `/keepalive/status` endpoint, expose failure count per workspace |
| `src/components/workspaces/KeepAliveWarning.tsx` | **NEW** Warning banner | Renders destructive Alert when consecutiveFailures >= 3 |
| `src/components/workspaces/TerminalTabManager.tsx` | Tab manager | Mount `KeepAliveWarning` component above terminal tabs |
| `src/app/workspaces/[id]/terminal/page.tsx` | Terminal page | Pass workspaceId to TerminalClient for keep-alive status |

### Coder API Endpoint Details

- **Endpoint:** `PUT /api/v2/workspaces/{workspace_id}/extend`
- **Auth:** `Coder-Session-Token` header (already available as `CODER_SESSION_TOKEN` env var in terminal-proxy)
- **Request body:** `{ "deadline": "2026-04-15T15:00:00Z" }` — ISO 8601 timestamp for new auto-stop deadline
- **Response:** `200 OK` with `{ "message": "...", "detail": "..." }`
- **Behavior:** Pushes the workspace auto-stop deadline to the specified time. Set deadline to `now + 60min` on each ping to maintain a rolling 1-hour buffer.

### Build Order

1. **CoderClient.extendWorkspace** — Add the API method and types. Unit test with mocked fetch.
2. **KeepAliveManager** — Core service class with interval timer, active-workspace tracking (consuming proxy's connection registry), consecutive failure counter per workspace. Unit test with mocked CoderClient.
3. **Proxy integration** — Wire KeepAliveManager into terminal-proxy's index.ts. Export active connection registry from proxy.ts. Add `/keepalive/status` HTTP endpoint returning JSON `{ workspaces: { [id]: { consecutiveFailures: number, lastSuccess: string | null, lastFailure: string | null } } }`.
4. **Frontend hook + banner** — `useKeepAliveStatus` hook polling the proxy endpoint. `KeepAliveWarning` component using shadcn Alert destructive variant. Mount in TerminalTabManager.
5. **Integration test** — Verify end-to-end: proxy with mock Coder API, keep-alive pings, failure accumulation, status endpoint, frontend rendering.

### Verification Approach

- **Unit tests:** `extendWorkspace` method (correct URL, method, headers, body), KeepAliveManager (starts/stops pinging when connections appear/disappear, increments failure counter, resets on success, respects 3-failure threshold)
- **Integration tests:** Terminal-proxy with mocked Coder API — verify pings happen on interval, verify `/keepalive/status` returns correct failure counts
- **Frontend tests:** `KeepAliveWarning` renders nothing when failures < 3, renders destructive alert when failures >= 3, disappears when failures reset
- **Manual verification:** Connect terminal, observe keep-alive pings in proxy logs, simulate API failure (invalid token), confirm banner appears after 3 failures

## Constraints

- The terminal-proxy runs as a separate Docker service — it has access to `CODER_URL` and `CODER_SESSION_TOKEN` env vars but does NOT share the Next.js runtime. The `CoderClient` class must be importable from the proxy context (or a minimal version duplicated).
- The proxy currently has no npm dependency on the main app — sharing `CoderClient` requires either: (a) extracting it to a shared package, (b) duplicating the minimal fetch logic in the proxy, or (c) making the proxy call a Next.js API route. Option (b) is simplest — the extend endpoint is a single authenticated PUT call.
- `CODER_URL` and `CODER_SESSION_TOKEN` are already available in the proxy environment (used for upstream WebSocket auth).
- The keep-alive ping interval should be shorter than the Coder activity bump duration. The template uses 1-hour activity bumps — pinging every 50-55 seconds with a 60-minute deadline extension provides a comfortable margin.

## Common Pitfalls

- **Workspace ID vs Agent ID:** The proxy tracks connections by `agentId`, but the extend API needs `workspaceId`. The proxy must maintain a mapping from agentId to workspaceId. This can be added as a query parameter when the frontend connects to the proxy WebSocket (the frontend already has workspaceId context).
- **Stale pings after disconnect:** When all WebSocket connections for a workspace close, the keep-alive must stop pinging that workspace. Otherwise it keeps dead workspaces alive indefinitely, violating the user's intent that "task workspaces should still clean up."
- **Race condition on startup:** If the proxy restarts, all connections re-establish. The keep-alive must not ping until at least one connection is confirmed active.
- **Clock skew:** The deadline timestamp is absolute. If the server clock is skewed relative to the Coder server, the deadline may be too short or too long. Use a relative offset (e.g., `now + 60min`) and ensure NTP is configured.
- **Token expiry:** The `CODER_SESSION_TOKEN` could expire. The keep-alive should log clear errors when the API returns 401 so the operator knows to rotate the token.

## Open Risks

- **Coder API rate limits:** Unknown whether Coder rate-limits the extend endpoint. With many workspaces, pinging every 55 seconds each could hit limits. Mitigation: start with a single-workspace scenario (Hive typically manages 1-3 workspaces), add rate-limit detection later.
- **`server.ts` reference in M006-CONTEXT.md:** The context document references a custom `server.ts` for keep-alive initialization, but no such file exists. The actual architecture uses standard Next.js (`next dev`/`next start`) with a separate terminal-proxy service. The keep-alive belongs in the terminal-proxy, not in a non-existent custom server.
- **Extend endpoint reliability:** GitHub issues suggest the extend endpoint may not always behave as expected (see coder/coder#15515). The implementation should verify the deadline was actually extended by checking the workspace response after the PUT call.

## Skills Discovered

None — no relevant slash commands or vault skills found for this slice.
