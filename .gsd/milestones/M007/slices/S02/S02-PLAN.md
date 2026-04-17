# S02: Terminal Integration & Session Management

**Goal:** Terminal sessions listed under each workspace in sidebar. Clicking a session navigates to full-page terminal. All keystrokes captured by xterm. Session create/kill/switch from sidebar. Stale entry clicks trigger error + sidebar refresh.
**Demo:** Terminal sessions listed under each workspace in sidebar. Clicking a session navigates to full-page terminal. All keystrokes captured by xterm. Session create/kill/switch from sidebar. Stale entry clicks trigger error + sidebar refresh.

## Must-Haves

- # S02: Terminal Integration & Session Management
- **Goal:** Terminal sessions listed under each workspace in sidebar. Clicking a session navigates to full-page terminal. All keystrokes captured by xterm. Session create/kill/switch from sidebar. Stale entry clicks trigger error + sidebar refresh.
- **Demo:** Expand a workspace in the sidebar to see terminal sessions and external-link buttons. Click "+" to create a session and navigate to full-viewport terminal page. All keystrokes reach xterm. Kill a session from sidebar. Click a stale entry and see error + sidebar auto-refresh.
- ## Must-Haves
- Each workspace in sidebar is a collapsible with nested terminal sessions fetched via `getWorkspaceSessionsAction` (R057)
- Three external-link icon buttons per workspace: Filebrowser, KasmVNC, Code Server using `buildWorkspaceUrls()` (R057)
- "+" button creates session via `createSessionAction` and navigates to terminal page (R058)
- "x" button kills session via `killSessionAction` and removes from sidebar list (R058)
- Clicking a session navigates to `/workspaces/[id]/terminal?session=<name>` (R058)
- Terminal page is full-viewport with no layout padding intercepting space (R063)
- `term.focus()` called on mount and after sidebar toggle; keydown stopPropagation on terminal container (R063)
- Stale entry click shows error Alert and triggers sidebar force-refresh via custom event (R068)
- Integration test verifies keystroke exclusivity after mount and sidebar toggle (R069)
- ## Threat Surface
- **Abuse**: Session names are validated server-side against `SAFE_IDENTIFIER_RE` — no injection risk. `killSessionAction` requires valid workspaceId + sessionName. No privilege escalation since all actions use the server's CODER_SESSION_TOKEN.
- **Data exposure**: None — no PII or secrets exposed in sidebar or terminal page URL params.
- **Input trust**: Session names from user input (create flow) are validated by zod schema + regex on server. External link URLs are constructed from trusted server-side workspace data, not user input.
- ## Requirement Impact
- **Requirements touched**: R056 (sidebar structure — adding nesting depth), R059 (polling — adding per-workspace session polling)
- **Re-verify**: Existing workspace/template rendering in sidebar still works after nesting changes. 30s global polling still functions.
- **Decisions revisited**: D030 (keystroke capture — implementing the auto-focus strategy), D031 (external links in sidebar — implementing the new-tab approach)
- ## Proof Level
- This slice proves: integration
- Real runtime required: yes (WebSocket terminal connections, Coder API calls)
- Human/UAT required: yes (keystroke capture behavior, sidebar UX)
- ## Verification
- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — all existing + new tests pass
- `pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — keystroke exclusivity tests pass
- `grep -q 'getWorkspaceSessionsAction' src/components/app-sidebar.tsx` — sessions fetched in sidebar
- `grep -q 'buildWorkspaceUrls' src/components/app-sidebar.tsx` — external links wired
- `grep -q 'createSessionAction' src/components/app-sidebar.tsx` — create session from sidebar
- `grep -q 'killSessionAction' src/components/app-sidebar.tsx` — kill session from sidebar
- `grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx` — focus management added
- `grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx` — keystroke capture
- `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/page.tsx` — stale entry refresh
- `pnpm tsc --noEmit 2>&1 | grep -v 'council-queues\|task-queue\|ioredis' | grep -c 'error TS' | grep -q '^0$'` — no new TypeScript errors
- ## Observability / Diagnostics
- Runtime signals: Console logs from server actions (`[workspaces]` prefix) for session create/kill/list operations. Custom event `hive:sidebar-refresh` dispatched on stale entry detection.
- Inspection surfaces: Browser DevTools console for `[workspaces]` logs. React DevTools for sidebar state (workspace expansion, session lists). Network tab for server action calls.
- Failure visibility: Inline Alert in terminal page for missing agent/session. Sidebar error alerts with retry for failed session fetches. Console errors for WebSocket connection failures.
- Redaction constraints: None — no secrets in sidebar or terminal page state.
- ## Integration Closure
- Upstream surfaces consumed: `src/components/app-sidebar.tsx` (S01 collapsible pattern), `src/lib/actions/workspaces.ts` (session CRUD actions), `src/lib/workspaces/urls.ts` (`buildWorkspaceUrls`), `src/lib/workspaces/sessions.ts` (`TmuxSession` type), `src/components/workspaces/InteractiveTerminal.tsx` (xterm component), `src/app/layout.tsx` (SidebarProvider context)
- New wiring introduced in this slice: Sidebar-to-terminal navigation via session links, per-workspace session polling on expand, custom event bridge `hive:sidebar-refresh` for stale entry recovery, terminal container keystroke isolation
- What remains before the milestone is truly usable end-to-end: S03 (template detail pages, sidebar pin/unpin toggle)
- ## Tasks
- [x] **T01: Nest terminal sessions and external-link buttons under each workspace in sidebar** `est:2h`
- Why: Delivers R057 (external links) and R058 (session CRUD from sidebar) — the core sidebar enhancement for this slice
- Files: `src/components/app-sidebar.tsx`, `src/__tests__/components/app-sidebar.test.tsx`
- Do: Make each workspace a nested Collapsible with: (1) lazy-fetch agent info via `getWorkspaceAgentAction` on first expand, cache in state, (2) fetch sessions via `getWorkspaceSessionsAction` on expand + 30s polling for expanded workspaces, (3) three external-link icon buttons (Filebrowser, KasmVNC, Code Server) using `buildWorkspaceUrls()`, (4) "+" button to create session and navigate via `router.push`, (5) "x" button per session to kill via `killSessionAction`, (6) session items link to `/workspaces/[id]/terminal?session=<name>`. Import `useRouter` from next/navigation. Add `TmuxSession` type import. Use existing S01 Collapsible/SidebarMenuSub pattern for nesting. External links open in new tabs with `target="_blank"`. Extend test suite with tests for session rendering, external link buttons, create/kill actions.
- Verify: `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` passes all tests including new ones
- Done when: Sidebar shows sessions nested under workspaces, external links render, create/kill actions work, tests pass
- [x] **T02: Make terminal page full-viewport with keystroke exclusivity** `est:1h`
- Why: Delivers R063 — terminal must fill the viewport and capture all keystrokes without sidebar/layout interference
- Files: `src/app/workspaces/[id]/terminal/terminal-client.tsx`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/app/workspaces/[id]/terminal/page.tsx`
- Do: (1) In `terminal-client.tsx`: wrap terminal in a container that uses negative margins and calc() to fill the full viewport minus sidebar width — replace current `-m-6` / `calc(100vh - 3.5rem)` with a full-bleed approach: use `-m-6 -mt-14` and `h-[100vh] w-full` to cancel the layout padding entirely. Add `onKeyDown={e => e.stopPropagation()}` on the terminal wrapper div. (2) In `InteractiveTerminal.tsx`: after `term.open(containerRef.current)`, add `term.focus()`. Add a `useEffect` that listens for `focusin` events on the container and calls `term.focus()` when the container or its children receive focus. Store `termRef` and expose a focus method. (3) In `page.tsx`: update the error state container to also use full-viewport sizing for consistency.
- Verify: `grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx && grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx`
- Done when: Terminal page fills viewport edge-to-edge (no padding gaps), `term.focus()` called on mount, keydown events don't bubble past terminal container
- [ ] **T03: Add stale entry error handling with sidebar force-refresh** `est:45m`
- Why: Delivers R068 — clicking a stale sidebar entry must not leave the user in a broken state
- Files: `src/app/workspaces/[id]/terminal/page.tsx`, `src/app/workspaces/[id]/terminal/terminal-client.tsx`, `src/components/app-sidebar.tsx`
- Do: (1) In `page.tsx`: when `getWorkspaceAgentAction` fails, dispatch `window.dispatchEvent(new CustomEvent('hive:sidebar-refresh'))` alongside showing the existing error Alert. Add a "Back to workspaces" link in the error state. (2) In `terminal-client.tsx`: when no `?session` param is present, also dispatch the refresh event (stale link without session param). (3) In `app-sidebar.tsx`: add a `useEffect` that listens for the `hive:sidebar-refresh` custom event and calls `fetchAll()` when received. Clean up the listener on unmount. (4) Extend sidebar tests to verify the custom event listener is registered and triggers fetchAll.
- Verify: `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/page.tsx && grep -q 'hive:sidebar-refresh' src/components/app-sidebar.tsx`
- Done when: Stale terminal page dispatches refresh event, sidebar listens and re-fetches, error state shows with navigation option
- [ ] **T04: Write keystroke exclusivity integration test** `est:45m`
- Why: Delivers R069 — automated verification that keystroke capture doesn't regress after mount or sidebar interactions
- Files: `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx`
- Do: (1) Create new test file following patterns from `interactive-terminal-integration.test.tsx`. (2) Mock xterm Terminal with `focus` spy and `onData` callback capture. Mock FitAddon, useTerminalWebSocket, sidebar components. (3) Test: after mount, verify `term.focus()` was called. (4) Test: fire keydown event on terminal container, verify `stopPropagation` prevents bubbling (attach a listener on a parent div, assert it does NOT receive the event). (5) Test: simulate `focusin` on terminal container, verify `term.focus()` called again. Use the same `vi.hoisted`, `vi.mock`, and `act()` patterns as the existing integration tests. Mock `useSearchParams` to return a session param.
- Verify: `pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx`
- Done when: All keystroke exclusivity tests pass, covering mount focus, event non-bubbling, and re-focus on container interaction

## Proof Level

- This slice proves: integration

## Integration Closure

Upstream: app-sidebar.tsx (S01 collapsible pattern), workspaces.ts (session CRUD actions), urls.ts (buildWorkspaceUrls), InteractiveTerminal.tsx (xterm). New wiring: sidebar-to-terminal session links, per-workspace session polling, hive:sidebar-refresh event bridge, terminal keystroke isolation. Remaining: S03 (template details, sidebar pin/unpin).

## Verification

- Console logs from server actions ([workspaces] prefix) for session CRUD. Custom event hive:sidebar-refresh for stale entry recovery. Inline Alert in terminal page for missing agent/session.

## Tasks

- [x] **T01: Nest terminal sessions and external-link buttons under each workspace in sidebar** `est:2h`
  ---
estimated_steps: 6
estimated_files: 5
skills_used: []
---

# T01: Nest terminal sessions and external-link buttons under each workspace in sidebar

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

Make each workspace in the sidebar a nested Collapsible that shows terminal sessions and external-link buttons. This delivers R057 (external links for Filebrowser, KasmVNC, Code Server) and R058 (session list/create/kill from sidebar).

Currently each workspace is a flat `SidebarMenuSubItem` with just a name and status badge. It needs to become a nested `Collapsible` containing: (1) the workspace name + badge as the trigger, (2) three external-link icon buttons, (3) a list of terminal sessions fetched via `getWorkspaceSessionsAction`, (4) a "+" button to create sessions, and (5) an "x" button per session to kill it.

**Agent name challenge:** `buildWorkspaceUrls()` requires `agentName` which is not on `CoderWorkspace`. Use `getWorkspaceAgentAction` to lazy-fetch agent info when a workspace collapsible is first expanded. Cache the result in component state keyed by workspace ID.

**Session polling:** Fetch sessions per-workspace when expanded, not globally. Use 30s polling scoped to expanded workspaces only, matching the S01 pattern.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| `getWorkspaceAgentAction` | Show inline error in workspace collapsible, disable external links | Same as error — agent info unavailable | Return null, skip external links |
| `getWorkspaceSessionsAction` | Show inline "Failed to load sessions" with retry | Same as error | Return empty array |
| `createSessionAction` | Show toast/alert, don't navigate | Same as error | Don't navigate |
| `killSessionAction` | Show toast/alert, don't remove from list | Same as error | Don't remove from list |

## Negative Tests

- **Malformed inputs**: Workspace with no agent (agent fetch returns error) — external links hidden, sessions show error
- **Error paths**: Session fetch failure — inline error with retry button, doesn't affect other workspaces
- **Boundary conditions**: Zero sessions — show only "+" button, no session list. Workspace stopped/offline — external links still render (URLs are valid, target app may be down)

## Steps

1. Add imports to `app-sidebar.tsx`: `useRouter` from `next/navigation`, `getWorkspaceAgentAction`, `getWorkspaceSessionsAction`, `createSessionAction`, `killSessionAction` from `@/lib/actions/workspaces`, `buildWorkspaceUrls` from `@/lib/workspaces/urls`, `TmuxSession` from `@/lib/workspaces/sessions`, and new lucide icons (`Terminal`, `Plus`, `X`, `FolderOpen`, `Monitor as ScreenIcon`, `Code`). Add `ExternalLink` icon for the link buttons.

2. Add state management for per-workspace expansion and data:
   - `expandedWorkspaces: Record<string, boolean>` — tracks which workspaces are expanded
   - `workspaceAgents: Record<string, { agentId: string; agentName: string } | null>` — cached agent info per workspace
   - `workspaceSessions: Record<string, { data: TmuxSession[]; isLoading: boolean; error: string | null }>` — sessions per workspace
   - `fetchAgentInfo(workspaceId: string)` — calls `getWorkspaceAgentAction`, caches result
   - `fetchSessions(workspaceId: string)` — calls `getWorkspaceSessionsAction`, updates state
   - `handleWorkspaceExpand(workspaceId: string, open: boolean)` — on first expand, fetch agent + sessions

3. Add per-workspace session polling: `useEffect` that sets up 30s intervals for each expanded workspace. Use a ref map to track interval IDs. Clear intervals when workspaces collapse or component unmounts.

4. Replace the flat workspace list with nested Collapsibles. Each workspace becomes:
   ```
   Collapsible (onOpenChange → handleWorkspaceExpand)
     CollapsibleTrigger: workspace name + status badge
     CollapsibleContent:
       - External links row: 3 icon buttons (Filebrowser, KasmVNC, Code Server) — each `<a href={url} target="_blank">`
       - SidebarMenuSub with sessions:
         - Each session: SidebarMenuSubItem linking to `/workspaces/[id]/terminal?session=<name>` with "x" kill button
         - "+" button at bottom to create new session
       - Error state: Alert with retry if session fetch failed
       - Loading state: "Loading sessions..." text
   ```

5. Implement create session handler: call `createSessionAction({ workspaceId })`, then `router.push(`/workspaces/${workspaceId}/terminal?session=${result.data.name}`)`. Re-fetch sessions after creation.

6. Implement kill session handler: call `killSessionAction({ workspaceId, sessionName })`, then remove from local state. Re-fetch sessions to confirm.

7. Extend `app-sidebar.test.tsx` with new tests:
   - Mock `getWorkspaceAgentAction`, `getWorkspaceSessionsAction`, `createSessionAction`, `killSessionAction`
   - Test: expanding a workspace triggers agent + session fetch
   - Test: sessions render as sub-items under workspace
   - Test: external link buttons render with correct href targets
   - Test: "+" button calls createSessionAction
   - Test: "x" button calls killSessionAction
   - Test: session fetch error shows inline alert with retry

## Must-Haves

- [ ] Each workspace is a Collapsible with nested sessions
- [ ] Three external-link buttons per workspace (Filebrowser, KasmVNC, Code Server)
- [ ] Sessions fetched lazily on workspace expand
- [ ] "+" creates session and navigates to terminal page
- [ ] "x" kills session and removes from list
- [ ] Session items link to `/workspaces/[id]/terminal?session=<name>`
- [ ] Agent info lazy-fetched and cached per workspace
- [ ] 30s polling for sessions of expanded workspaces
- [ ] Error state with retry for failed session fetches
- [ ] All existing sidebar tests still pass
- [ ] New tests cover session nesting, external links, create/kill

## Verification

- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — all tests pass (existing + new)
- `grep -q 'getWorkspaceSessionsAction' src/components/app-sidebar.tsx`
- `grep -q 'buildWorkspaceUrls' src/components/app-sidebar.tsx`
- `grep -q 'createSessionAction' src/components/app-sidebar.tsx`
- `grep -q 'killSessionAction' src/components/app-sidebar.tsx`

## Inputs

- `src/components/app-sidebar.tsx` — S01 sidebar with flat workspace list to extend
- `src/__tests__/components/app-sidebar.test.tsx` — existing test suite to extend
- `src/lib/actions/workspaces.ts` — server actions for session CRUD (getWorkspaceAgentAction, getWorkspaceSessionsAction, createSessionAction, killSessionAction)
- `src/lib/workspaces/urls.ts` — buildWorkspaceUrls function for external link URLs
- `src/lib/workspaces/sessions.ts` — TmuxSession type
- `src/lib/coder/types.ts` — CoderWorkspace type (has owner_name field)

## Expected Output

- `src/components/app-sidebar.tsx` — workspace items now Collapsible with nested sessions, external links, create/kill buttons
- `src/__tests__/components/app-sidebar.test.tsx` — extended with 6+ new tests for session nesting, external links, CRUD
  - Files: `src/components/app-sidebar.tsx`, `src/__tests__/components/app-sidebar.test.tsx`
  - Verify: pnpm vitest run src/__tests__/components/app-sidebar.test.tsx

- [ ] **T02: Make terminal page full-viewport with keystroke exclusivity** `est:1h`
  ---
estimated_steps: 4
estimated_files: 3
skills_used: []
---

# T02: Make terminal page full-viewport with keystroke exclusivity

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

The terminal page at `/workspaces/[id]/terminal` currently uses `calc(100vh - 3.5rem - 3rem)` and `-m-6` for partial expansion. It needs to be truly full-viewport with exclusive keystroke capture (R063). The root layout applies `p-6 pt-14` to `<main>` — the terminal page must cancel this padding entirely.

Keystroke exclusivity (per D030): auto-focus xterm on mount, re-focus on container interaction. Add `stopPropagation` on the terminal wrapper to prevent keyboard events from reaching sidebar or other layout elements.

## Steps

1. In `src/app/workspaces/[id]/terminal/terminal-client.tsx`:
   - Change the terminal wrapper div from `-m-6` / `calc(100vh - 3.5rem)` to `-m-6 -mt-14` with `h-[100vh] w-[calc(100%+3rem)]` to fully cancel the layout's `p-6 pt-14` padding
   - Add `onKeyDown={(e) => e.stopPropagation()}` on the terminal wrapper div to prevent keystroke bubbling
   - Update the "Waiting for session" and Suspense fallback containers to use the same full-viewport sizing

2. In `src/components/workspaces/InteractiveTerminal.tsx`:
   - After `term.open(containerRef.current)` (around line 142), add `term.focus()` to auto-focus on mount
   - Add a click handler on the container div: `onClick={() => termRef.current?.focus()}` so clicking anywhere in the terminal area re-focuses xterm
   - This implements D030's strategy: auto-focus on mount, re-focus on click within terminal area

3. In `src/app/workspaces/[id]/terminal/page.tsx`:
   - Update the error state container to use full-viewport sizing consistent with the terminal view (`-m-6 -mt-14 h-[100vh]`)

4. Verify the terminal fills the viewport by checking the CSS changes compile and the component renders without errors.

## Must-Haves

- [ ] Terminal page fills full viewport (no layout padding visible)
- [ ] `term.focus()` called after mount
- [ ] Click on terminal container re-focuses xterm
- [ ] `stopPropagation` on terminal wrapper keydown events
- [ ] Error state also uses full-viewport sizing
- [ ] No TypeScript errors in modified files

## Verification

- `grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx` — focus call present
- `grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx` — keystroke isolation present
- `grep -q '\-mt-14' src/app/workspaces/[id]/terminal/terminal-client.tsx` — full-viewport margins present
- `pnpm tsc --noEmit 2>&1 | grep -v 'council-queues\|task-queue\|ioredis' | grep 'terminal' | grep -c 'error TS'` returns 0

## Inputs

- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — current terminal client with partial viewport expansion
- `src/components/workspaces/InteractiveTerminal.tsx` — xterm component needing focus management
- `src/app/workspaces/[id]/terminal/page.tsx` — server component with error state
- `src/app/layout.tsx` — root layout showing `p-6 pt-14` padding to cancel (read-only reference)

## Expected Output

- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — full-viewport sizing, stopPropagation on keydown
- `src/components/workspaces/InteractiveTerminal.tsx` — term.focus() on mount, click-to-refocus
- `src/app/workspaces/[id]/terminal/page.tsx` — error state with full-viewport sizing
  - Files: `src/app/workspaces/[id]/terminal/terminal-client.tsx`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/app/workspaces/[id]/terminal/page.tsx`
  - Verify: grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx && grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx

- [ ] **T03: Add stale entry error handling with sidebar force-refresh** `est:45m`
  ---
estimated_steps: 4
estimated_files: 4
skills_used: []
---

# T03: Add stale entry error handling with sidebar force-refresh

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

When a sidebar entry points to a workspace/session that no longer exists, clicking it must show an error and trigger the sidebar to refresh its data (R068). The terminal page already has basic error handling for missing agents — this task extends it to dispatch a `hive:sidebar-refresh` custom event that the sidebar listens for.

## Steps

1. In `src/app/workspaces/[id]/terminal/page.tsx`:
   - The page is a server component, so it cannot dispatch browser events directly. Instead, create a small client component `StaleEntryAlert` that renders the error Alert AND dispatches `window.dispatchEvent(new CustomEvent('hive:sidebar-refresh'))` in a `useEffect` on mount.
   - Replace the current inline error JSX with `<StaleEntryAlert workspaceId={workspaceId} />`.
   - The `StaleEntryAlert` component should show the existing "Could not find a running agent" message plus a Link back to `/workspaces` (or `/tasks` as the home route).
   - Keep the component in the same file or a co-located file like `stale-entry-alert.tsx`.

2. In `src/app/workspaces/[id]/terminal/terminal-client.tsx`:
   - In the `TerminalInner` component, when `!session` (no session param), add a `useEffect` that dispatches `hive:sidebar-refresh` to trigger sidebar data reload. This handles the case where a stale link has no session param.

3. In `src/components/app-sidebar.tsx`:
   - Add a `useEffect` that listens for the `hive:sidebar-refresh` custom event on `window`.
   - When received, call `fetchAll()` to re-fetch workspaces and templates.
   - Clean up the event listener on unmount.

4. Extend `src/__tests__/components/app-sidebar.test.tsx`:
   - Add a test: dispatch `hive:sidebar-refresh` custom event, verify `fetchAll` (both mock actions) is called again.

## Must-Haves

- [ ] Terminal page error state dispatches `hive:sidebar-refresh` event
- [ ] Missing session param dispatches `hive:sidebar-refresh` event
- [ ] Sidebar listens for `hive:sidebar-refresh` and calls fetchAll
- [ ] Error state includes navigation link back to home
- [ ] Event listener cleaned up on sidebar unmount
- [ ] Test verifies custom event triggers sidebar refresh

## Verification

- `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/page.tsx` — event dispatched on error
- `grep -q 'hive:sidebar-refresh' src/components/app-sidebar.tsx` — sidebar listens for event
- `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/terminal-client.tsx` — missing session dispatches event
- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — all tests pass including new custom event test

## Inputs

- `src/app/workspaces/[id]/terminal/page.tsx` — server component with existing error handling for missing agent
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — client component with session param handling
- `src/components/app-sidebar.tsx` — sidebar component (from T01 output) to add event listener
- `src/__tests__/components/app-sidebar.test.tsx` — test suite (from T01 output) to extend

## Expected Output

- `src/app/workspaces/[id]/terminal/page.tsx` — uses StaleEntryAlert client component that dispatches refresh event
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — dispatches refresh event when no session param
- `src/components/app-sidebar.tsx` — listens for hive:sidebar-refresh event
- `src/__tests__/components/app-sidebar.test.tsx` — new test for custom event listener
  - Files: `src/app/workspaces/[id]/terminal/page.tsx`, `src/app/workspaces/[id]/terminal/terminal-client.tsx`, `src/components/app-sidebar.tsx`, `src/__tests__/components/app-sidebar.test.tsx`
  - Verify: grep -q 'hive:sidebar-refresh' src/components/app-sidebar.tsx && pnpm vitest run src/__tests__/components/app-sidebar.test.tsx

- [ ] **T04: Write keystroke exclusivity integration test** `est:45m`
  ---
estimated_steps: 4
estimated_files: 1
skills_used: []
---

# T04: Write keystroke exclusivity integration test

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

Create an integration test that verifies terminal keystroke exclusivity (R069). The test must confirm that: (1) `term.focus()` is called after mount, (2) keyboard events on the terminal container don't bubble to parent elements, and (3) clicking the terminal container re-triggers focus. Follow mock patterns from `src/__tests__/integration/interactive-terminal-integration.test.tsx`.

## Steps

1. Create `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` with the standard vitest-environment jsdom header.

2. Set up mocks following `interactive-terminal-integration.test.tsx` patterns:
   - Use `vi.hoisted` for `mockFit` and `mockFocus` spies
   - Mock `@xterm/xterm` Terminal class with `focus: mockFocus`, `open`, `loadAddon`, `onData`, `onResize`, `dispose`, `write`, `rows: 24`, `cols: 80`
   - Mock `@xterm/addon-fit` FitAddon with `fit: mockFit`
   - Mock `@/hooks/useTerminalWebSocket` returning `{ send: vi.fn(), resize: vi.fn(), connectionState: 'disconnected' }`
   - Mock `@/lib/terminal/protocol`, `@/lib/utils`, `@/components/ui/alert`, `lucide-react`, `@/styles/xterm.css`
   - Mock `@/lib/terminal/config` with `TERMINAL_THEME: {}`, `TERMINAL_FONT_FAMILY: 'monospace'`, `loadTerminalFont: () => Promise.resolve()`
   - Set up `ResizeObserver` mock, `requestAnimationFrame` mock, `document.fonts.ready`, and `NEXT_PUBLIC_TERMINAL_WS_URL` env var in `beforeEach`

3. Write the `renderTerminal` helper (same pattern as existing integration test — dynamic import of InteractiveTerminal, render with act, await tick).

4. Write test cases:
   - **"calls term.focus() after mount"**: render terminal, assert `mockFocus` was called at least once
   - **"keydown events on container do not bubble to parent"**: render terminal inside a parent div with a keydown spy. The `InteractiveTerminal` component itself doesn't stopPropagation (that's in `terminal-client.tsx`), so this test should wrap the terminal in a div with `onKeyDown={e => e.stopPropagation()}` mimicking the terminal-client wrapper, fire a keydown on the terminal container, and assert the grandparent spy was NOT called.
   - **"clicking terminal container calls term.focus()"**: render terminal, clear mockFocus, simulate click on the terminal container div, assert mockFocus was called. The InteractiveTerminal has an `onClick` handler added in T02 that calls `termRef.current?.focus()`.

## Must-Haves

- [ ] Test file created at `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx`
- [ ] Uses same mock patterns as existing integration tests
- [ ] Tests focus-on-mount behavior
- [ ] Tests keystroke non-bubbling with stopPropagation wrapper
- [ ] Tests click-to-refocus behavior
- [ ] All tests pass

## Verification

- `pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — all tests pass
- `test -f src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — file exists

## Inputs

- `src/__tests__/integration/interactive-terminal-integration.test.tsx` — reference for mock patterns and test structure
- `src/components/workspaces/InteractiveTerminal.tsx` — component under test (with focus management from T02)
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — reference for stopPropagation wrapper pattern (from T02)

## Expected Output

- `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — new integration test file with 3 test cases for keystroke exclusivity
  - Files: `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx`
  - Verify: pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx

## Files Likely Touched

- src/components/app-sidebar.tsx
- src/__tests__/components/app-sidebar.test.tsx
- src/app/workspaces/[id]/terminal/terminal-client.tsx
- src/components/workspaces/InteractiveTerminal.tsx
- src/app/workspaces/[id]/terminal/page.tsx
- src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx
