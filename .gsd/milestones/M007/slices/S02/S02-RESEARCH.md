# S02 Research — Terminal Integration & Session Management

## Summary

S02 extends the sidebar delivered in S01 to nest terminal sessions under each workspace, adds external-link buttons (Filebrowser, KasmVNC, Code Server) per workspace, creates a dedicated full-viewport terminal page route, and handles stale-entry errors. The existing codebase already has mature server actions for session CRUD (`getWorkspaceSessionsAction`, `createSessionAction`, `killSessionAction`), a fully functional `InteractiveTerminal` xterm component with WebSocket reconnection, and a `TerminalTabManager` that manages tabs with a reducer. The primary work is (1) surfacing session lists and external links in the sidebar, (2) making the terminal page truly full-viewport with exclusive keystroke capture, (3) adding stale-entry error handling with sidebar force-refresh, and (4) writing the keystroke exclusivity integration test.

## Recommendation

Build in four steps: sidebar workspace nesting first (R057/R058), then full-viewport terminal page (R063), then stale-entry handling (R068), then the integration test (R069). The session management server actions are already complete — no backend work is needed. The sidebar changes are the largest surface area.

## Implementation Landscape

### Key Files

| File | Role | S02 Changes Needed |
|------|------|--------------------|
| `src/components/app-sidebar.tsx` | Sidebar component | Major: nest sessions under each workspace, add external-link buttons, add per-workspace session polling, add "+" button for creating sessions, add kill button per session |
| `src/lib/actions/workspaces.ts` | Server actions for workspace/session CRUD | None — already has `getWorkspaceSessionsAction`, `createSessionAction`, `killSessionAction`, `getWorkspaceAgentAction` |
| `src/lib/workspaces/sessions.ts` | `parseTmuxSessions()` parser | None — already complete |
| `src/lib/workspaces/urls.ts` | `buildWorkspaceUrls()` — returns filebrowser, kasmvnc, codeServer, dashboard URLs | None — already returns `codeServer` URL |
| `src/app/workspaces/[id]/terminal/page.tsx` | Terminal page (server component) | Moderate: needs full-viewport layout adjustment for R063 |
| `src/app/workspaces/[id]/terminal/terminal-client.tsx` | Terminal client wrapper | Moderate: make full-viewport, ensure exclusive keystroke capture (prevent sidebar/layout from intercepting keys) |
| `src/components/workspaces/InteractiveTerminal.tsx` | xterm component | Minor: may need explicit `term.focus()` call on mount/visibility for R063 keystroke exclusivity |
| `src/components/workspaces/TerminalTabManager.tsx` | Tab management UI | Reference only — session CRUD patterns to reuse in sidebar |
| `src/components/workspaces/WorkspaceToolPanel.tsx` | Current workspace detail panel with tool picker | Reference — shows how external links are built today |
| `src/hooks/useTerminalWebSocket.ts` | WebSocket hook with reconnection | None — already complete |
| `src/app/layout.tsx` | Root layout with SidebarProvider | Minor: terminal page may need to opt out of padding (`p-6 pt-14`) for full-viewport |
| `src/__tests__/components/app-sidebar.test.tsx` | Existing sidebar tests | Extend: add tests for session nesting, external links, create/kill actions |

### Current Architecture

**Session management flow:**
1. `getWorkspaceSessionsAction({ workspaceId })` — runs `tmux -L web list-sessions` via `execInWorkspace`, returns `TmuxSession[]` with `{ name, created, windows }`
2. `createSessionAction({ workspaceId, sessionName? })` — allocates a session name (tmux creates on PTY connect via `-A` flag), returns `{ name }`
3. `killSessionAction({ workspaceId, sessionName })` — runs `tmux -L web kill-session -t <name>`, returns `{ name }`

**Terminal page route:** `/workspaces/[id]/terminal` — server component fetches agent via `getWorkspaceAgentAction`, renders `TerminalClient` which reads `?session=` from search params and renders `InteractiveTerminal`.

**xterm focus:** Currently no explicit focus management. The `InteractiveTerminal` component creates a Terminal instance and opens it in a container div. Focus happens implicitly when the user clicks. For R063 (exclusive keystroke capture), `term.focus()` must be called after mount and after sidebar toggle.

**External links:** `buildWorkspaceUrls()` in `src/lib/workspaces/urls.ts` already generates URLs for filebrowser, kasmvnc, codeServer, and dashboard. The sidebar currently has no access to these URLs because it only receives `coderUrl` as a prop and workspace items don't carry `owner_name` or `agentName`. The `CoderWorkspace` type includes `owner_name`. Agent name requires an extra call or can be hardcoded/inferred.

### Sidebar Nesting Design (R057/R058)

Each workspace in the sidebar needs to become a `Collapsible` with:
- The workspace name + status badge (existing)
- 3 external-link icon buttons: Filebrowser, KasmVNC, Code Server (new) — these open `target="_blank"` using URLs from `buildWorkspaceUrls()`
- Nested `SidebarMenuSub` listing terminal sessions fetched via `getWorkspaceSessionsAction`
- A "+" button to create a new session via `createSessionAction` and navigate to `/workspaces/[id]/terminal?session=<name>`
- An "x" button per session to kill it via `killSessionAction`

**Agent name challenge:** External links require `agentName` which is not on `CoderWorkspace`. Options:
1. Fetch agent info per workspace when expanding (lazy) — adds latency
2. Add agent name to the workspace list response — requires backend change
3. Default to common agent name (e.g., "main") — brittle but simple
4. Fetch all agents in parallel during sidebar load — adds N API calls

Recommendation: Lazy-fetch agent info when a workspace collapsible is first expanded. Cache in state. This avoids N+1 calls on sidebar load.

**Session polling:** Sessions should be fetched per-workspace when expanded, not globally. Use the same 30s polling pattern as S01 but scoped to expanded workspaces only.

### Full-Viewport Terminal (R063)

The terminal page at `/workspaces/[id]/terminal` currently uses `style={{ height: "calc(100vh - 3.5rem - 3rem)" }}` and `-m-6` to partially expand. For true full-viewport:
1. The terminal page should use negative margins or a layout slot to eliminate the `p-6 pt-14` padding from `layout.tsx`
2. The `InteractiveTerminal` container must be `h-screen w-screen` (or `100vh`/`100vw`) minus only the sidebar width
3. Keystroke exclusivity: call `term.focus()` on mount, on route navigation to the page, and after sidebar toggle. Add a `useEffect` that listens for sidebar state changes and re-focuses.
4. Prevent event bubbling: the terminal container should call `e.stopPropagation()` on keydown events to prevent the sidebar or other layout elements from capturing keystrokes.

### Stale Entry Handling (R068)

When a sidebar entry points to a workspace/session that no longer exists:
1. The terminal page will fail to find an agent or the session won't connect
2. The page should catch this error and display an Alert with a message like "Session not found"
3. The page should trigger a sidebar force-refresh by calling a shared callback (e.g., via React context or a custom event)
4. Implementation: add a `forceRefresh` function to the sidebar that can be called externally, exposed via context or a global event bus (`window.dispatchEvent(new CustomEvent('hive:sidebar-refresh'))`)

### Keystroke Exclusivity Test (R069)

Based on the existing test patterns in `src/__tests__/integration/interactive-terminal-integration.test.tsx`:
1. Mock xterm `Terminal` class with a `focus()` spy and an `onData` handler
2. Render `InteractiveTerminal` inside a layout that includes the sidebar
3. After mount: assert `term.focus()` was called
4. Simulate sidebar toggle (open/close): assert `term.focus()` is called again after toggle
5. Fire keyboard events on the terminal container: assert they reach the terminal's `onData` handler and do NOT bubble to the sidebar
6. Use `e.stopPropagation()` verification or check that no sidebar handler received the event

### Build Order

1. **T01 — Sidebar workspace nesting with sessions and external links (R057, R058)**
   - Make each workspace a collapsible in the sidebar
   - Add external-link buttons (Filebrowser, KasmVNC, Code Server) using `buildWorkspaceUrls()`
   - Fetch and display sessions under each workspace when expanded
   - Add "+" create and "x" kill buttons for sessions
   - Session items link to `/workspaces/[id]/terminal?session=<name>`
   - Extend `app-sidebar.test.tsx` with tests for new UI

2. **T02 — Full-viewport terminal page with keystroke exclusivity (R063)**
   - Adjust terminal page layout to be full-viewport (remove padding, use full height/width)
   - Add `term.focus()` on mount and after sidebar toggle
   - Add `stopPropagation` on terminal container keydown events
   - Update `terminal-client.tsx` to handle the `?session` param properly with the new sidebar-driven navigation

3. **T03 — Stale entry error handling with sidebar force-refresh (R068)**
   - Add error boundary/catch in terminal page for missing agent/session
   - Display Alert with "session not found" or "workspace offline" message
   - Implement sidebar force-refresh mechanism (custom event or context)
   - Test: click stale entry, verify error displayed and sidebar refreshes

4. **T04 — Keystroke exclusivity integration test (R069)**
   - Write integration test verifying terminal captures all keystrokes after mount
   - Verify keystrokes still captured after sidebar toggle
   - Follow existing mock patterns from `interactive-terminal-integration.test.tsx`

### Verification Approach

- **Unit tests:** Extend `app-sidebar.test.tsx` for session nesting, external links, create/kill actions
- **Integration test:** New test file for R069 keystroke exclusivity (mount + sidebar toggle scenarios)
- **Manual verification:** 
  - Open sidebar, expand a running workspace, verify sessions listed
  - Click "+" to create session, verify navigation to terminal page
  - Click "x" to kill session, verify removal from sidebar
  - Click external link buttons, verify correct URLs open in new tabs
  - On terminal page, verify all keystrokes go to terminal (type commands, use Ctrl+C, etc.)
  - Toggle sidebar while on terminal page, verify terminal regains focus
  - Navigate to a stale workspace/session, verify error + sidebar refresh
