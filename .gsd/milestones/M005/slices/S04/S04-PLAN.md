# S04: External Tool Integration

**Goal:** Workspace detail page shows embedded Filebrowser and KasmVNC in iframe panels with popup-out buttons, plus link-out to Coder dashboard. Falls back to links if iframe blocked.
**Demo:** Workspace detail page shows embedded Filebrowser and KasmVNC in iframe panels with popup-out buttons, plus link-out to Coder dashboard. Falls back to links if iframe blocked.

## Must-Haves

- # S04: External Tool Integration
- **Goal:** Workspace detail page shows embedded Filebrowser and KasmVNC in iframe panels with popup-out buttons, plus link-out to Coder dashboard. Falls back to links if iframe blocked.
- **Demo:** User clicks a workspace name on /workspaces, navigates to /workspaces/[id], sees tabbed Filebrowser/KasmVNC iframe panels, can switch tabs, pop out to new tab, and link out to Coder dashboard. Stopped workspaces show a disabled state.
- ## Must-Haves
- Workspace detail page at `/workspaces/[id]` with server-side workspace data loading
- `getWorkspaceAction(workspaceId)` server action returning a single `CoderWorkspace`
- `WorkspaceToolPanel` client component with two-tab toggle (Filebrowser | KasmVNC)
- Iframe renders the selected tool URL from `buildWorkspaceUrls()`
- Pop Out button per tab opens URL via `window.open()`
- Coder Dashboard link-out button (always new tab)
- Iframe error detection with automatic fallback to popup link
- Stopped/non-running workspace shows disabled state (no iframes, message explaining workspace must be running)
- Workspace name in list page links to detail page `/workspaces/[id]`
- R040 satisfied: iframe-embedded Filebrowser and KasmVNC per workspace with popup-out button; link-out for Coder dashboard
- ## Threat Surface
- **Abuse**: Workspace ID in URL is a UUID from Coder API — no user-controlled content reaches iframe src beyond what `buildWorkspaceUrls()` constructs from validated workspace metadata. No parameter tampering vector.
- **Data exposure**: Iframe content is served by Coder subdomain apps (Filebrowser, KasmVNC) — Hive does not proxy or store any data from these tools. Session cookies are Coder-managed.
- **Input trust**: The workspace ID route param is validated by the server action (Zod string validation) and used only as a Coder API lookup key. No user input reaches filesystem or DB.
- ## Requirement Impact
- **Requirements touched**: R040 (directly delivered), R035 (workspace list page — navigation modified to add detail page links)
- **Re-verify**: Workspace list page still renders correctly after adding detail page links
- **Decisions revisited**: D020 (confirmed — iframe embed approach with popup fallback)
- ## Proof Level
- This slice proves: integration
- Real runtime required: yes (iframe embedding requires running Coder workspace with subdomain apps)
- Human/UAT required: yes (iframe behavior and popup fallback require browser verification)
- ## Verification
- `pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx` — all tests pass
- `pnpm vitest run src/__tests__/lib/workspaces/actions.test.ts` — existing + new getWorkspaceAction tests pass
- `pnpm vitest run` — full suite passes with zero regressions
- `pnpm build` — builds successfully with /workspaces/[id] route listed
- `grep -q "getWorkspaceAction" src/lib/actions/workspaces.ts` — server action exists
- `test -f src/components/workspaces/WorkspaceToolPanel.tsx` — component exists
- `test -f src/app/workspaces/\\[id\\]/page.tsx` — detail page exists
- ## Integration Closure
- Upstream surfaces consumed: `src/lib/workspaces/urls.ts` (buildWorkspaceUrls), `src/lib/actions/workspaces.ts` (getWorkspaceAgentAction), `src/lib/coder/client.ts` (CoderClient.getWorkspace), `src/components/workspaces/WorkspacesClient.tsx` (list page)
- New wiring introduced in this slice: `/workspaces/[id]` route composing WorkspaceToolPanel with server-fetched workspace data; list page workspace name links to detail page
- What remains before the milestone is truly usable end-to-end: Terminal integration (S02/S03 already delivered), milestone validation
- ## Tasks
- [x] **T01: Build WorkspaceToolPanel component and add getWorkspaceAction server action** `est:45m`
- Why: Creates the core iframe panel component (R040) and the server action needed to fetch a single workspace for the detail page. These are the building blocks the detail page route depends on.
- Files: `src/components/workspaces/WorkspaceToolPanel.tsx`, `src/lib/actions/workspaces.ts`
- Do: (1) Add `getWorkspaceAction` to workspaces.ts — takes `{workspaceId}`, calls `client.getWorkspace(id)`, returns the workspace object. (2) Create `WorkspaceToolPanel.tsx` as a client component with: useState tab toggle (filebrowser | kasmvnc), iframe rendering the active tool URL, Pop Out button calling `window.open()`, Coder Dashboard link-out button, iframe error detection via `onLoad` check + setTimeout fallback that shows popup link UI, disabled state for non-running workspaces. Use `buildWorkspaceUrls()` from `urls.ts` for URL construction. Agent name comes from props (resolved server-side).
- Verify: `test -f src/components/workspaces/WorkspaceToolPanel.tsx && grep -q "getWorkspaceAction" src/lib/actions/workspaces.ts`
- Done when: WorkspaceToolPanel renders iframe with tab switching, popup-out, dashboard link-out, error fallback, and disabled state. getWorkspaceAction returns a single workspace by ID.
- [x] **T02: Create workspace detail page route and wire list page navigation** `est:30m`
- Why: Connects T01's components into the app — creates the `/workspaces/[id]` route and adds navigation from the workspace list page. Without this, the panel component has no page to live on and users can't reach it.
- Files: `src/app/workspaces/[id]/page.tsx`, `src/components/workspaces/WorkspacesClient.tsx`
- Do: (1) Create `/workspaces/[id]/page.tsx` as an async server component following the terminal page pattern — await params to get workspace ID, call `getWorkspaceAction` and `getWorkspaceAgentAction` in parallel, handle error states (no workspace found, no agent), pass workspace data + agent name + coderUrl to WorkspaceToolPanel. (2) In `WorkspacesClient.tsx`, make the workspace name a Next.js `<Link>` to `/workspaces/${ws.id}` so users can navigate from list to detail. Keep existing tool link buttons as-is (they remain as quick-access shortcuts).
- Verify: `test -f src/app/workspaces/\\[id\\]/page.tsx && pnpm build`
- Done when: `/workspaces/[id]` route renders WorkspaceToolPanel with workspace data. Workspace names in list page link to detail page. Build succeeds.
- [x] **T03: Add unit tests for WorkspaceToolPanel and getWorkspaceAction** `est:30m`
- Why: Validates component behavior and server action without a running Coder instance. Ensures tab switching, popup-out, error fallback, disabled state, and the new server action all work correctly.
- Files: `src/__tests__/components/workspace-tool-panel.test.tsx`, `src/__tests__/lib/workspaces/actions.test.ts`
- Do: (1) Create `workspace-tool-panel.test.tsx` with tests: renders filebrowser iframe by default, switches to kasmvnc tab, popup-out button calls window.open with correct URL, dashboard link-out renders with correct href, disabled state renders message instead of iframe when workspace is not running, error fallback UI renders when iframe error state is set. Mock `buildWorkspaceUrls` or pass URLs as props. (2) Add test to existing `actions.test.ts` for `getWorkspaceAction` — mock CoderClient.getWorkspace, verify it returns workspace data for valid ID.
- Verify: `pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx && pnpm vitest run src/__tests__/lib/workspaces/actions.test.ts`
- Done when: All new tests pass. Full test suite passes with zero regressions.
- ## Files Likely Touched
- `src/components/workspaces/WorkspaceToolPanel.tsx` (new)
- `src/app/workspaces/[id]/page.tsx` (new)
- `src/lib/actions/workspaces.ts` (modified)
- `src/components/workspaces/WorkspacesClient.tsx` (modified)
- `src/__tests__/components/workspace-tool-panel.test.tsx` (new)
- `src/__tests__/lib/workspaces/actions.test.ts` (modified)

## Proof Level

- This slice proves: integration — iframe embedding requires running Coder workspace with subdomain apps; unit tests verify component logic

## Integration Closure

- Upstream surfaces consumed: `src/lib/workspaces/urls.ts` (buildWorkspaceUrls), `src/lib/actions/workspaces.ts` (getWorkspaceAgentAction), `src/lib/coder/client.ts` (CoderClient.getWorkspace), `src/components/workspaces/WorkspacesClient.tsx` (list page)\n- New wiring: `/workspaces/[id]` route composing WorkspaceToolPanel with server-fetched workspace data; list page workspace name links to detail page\n- Remaining: milestone validation

## Verification

- Runtime signals: console.log in getWorkspaceAction for workspace fetch failures\n- Inspection surfaces: iframe error state visible in UI (fallback popup link shown), browser console for iframe load errors\n- Failure visibility: WorkspaceToolPanel shows explicit error/disabled state for non-running workspaces and iframe load failures\n- Redaction constraints: CODER_SESSION_TOKEN stays server-side only (getWorkspaceAction is a server action)

## Tasks

- [x] **T01: Build WorkspaceToolPanel component and add getWorkspaceAction server action** `est:45m`
  ## Description

Creates the core iframe panel component (R040) and the server action needed to fetch a single workspace for the detail page. These are the foundational building blocks that the detail page route (T02) depends on.

### What to build

**1. `getWorkspaceAction` server action** in `src/lib/actions/workspaces.ts`:
- Input schema: `{ workspaceId: z.string().min(1) }`
- Calls `client.getWorkspace(parsedInput.workspaceId)` using the existing `getCoderClient()` factory
- Returns the `CoderWorkspace` object directly
- Follow the exact pattern of `getWorkspaceAgentAction` already in the file

**2. `WorkspaceToolPanel` client component** in `src/components/workspaces/WorkspaceToolPanel.tsx`:
- Props: `{ workspace: CoderWorkspace; agentName: string; coderUrl: string }`
- Uses `buildWorkspaceUrls()` from `src/lib/workspaces/urls.ts` to construct tool URLs
- Two-tab toggle via `useState<'filebrowser' | 'kasmvnc'>('filebrowser')` — two buttons, active tab gets distinct styling
- Renders `<iframe>` with `src` set to the active tab's URL, `className` for full panel sizing
- "Pop Out" button per tab: calls `window.open(activeUrl, '_blank')`
- "Coder Dashboard" link-out button: `<a href={urls.dashboard} target="_blank" rel="noopener noreferrer">`
- Iframe error detection: after iframe mounts, use a `setTimeout` (3-5 seconds) — if iframe `contentWindow` access throws (cross-origin block), set error state and show fallback UI with direct link buttons
- Disabled state: if `workspace.latest_build.status !== 'running'`, render a message explaining the workspace must be running, with disabled/grayed-out tab buttons — no iframe rendered
- Use Lucide icons: `ExternalLink` for popup-out, `FolderOpen` for filebrowser tab, `Monitor` for kasmvnc tab, `LayoutDashboard` or `ExternalLink` for dashboard
- Use existing `Button` component from `src/components/ui/button`

## Steps

1. Read `src/lib/actions/workspaces.ts` and add `getWorkspaceAction` following the existing pattern (Zod schema → actionClient → getCoderClient → client method)
2. Read `src/lib/workspaces/urls.ts` to confirm `buildWorkspaceUrls` signature and imports
3. Create `src/components/workspaces/WorkspaceToolPanel.tsx` with the full component implementation
4. Verify the component file compiles: `pnpm exec tsc --noEmit src/components/workspaces/WorkspaceToolPanel.tsx` or run `pnpm build`

## Must-Haves

- [ ] `getWorkspaceAction` exported from `src/lib/actions/workspaces.ts` with Zod-validated workspaceId input
- [ ] `WorkspaceToolPanel` renders iframe with correct src URL based on active tab
- [ ] Tab toggle switches between filebrowser and kasmvnc
- [ ] Pop Out button calls `window.open` with the active tool URL
- [ ] Coder Dashboard link-out opens in new tab
- [ ] Disabled state shown when workspace is not running (no iframe rendered)
- [ ] Error fallback UI shown when iframe fails to load

## Verification

- `grep -q 'getWorkspaceAction' src/lib/actions/workspaces.ts` — action exists
- `test -f src/components/workspaces/WorkspaceToolPanel.tsx` — component exists
- `grep -q 'buildWorkspaceUrls' src/components/workspaces/WorkspaceToolPanel.tsx` — uses URL builder
- `grep -q 'window.open' src/components/workspaces/WorkspaceToolPanel.tsx` — popup-out wired
- `pnpm build` passes (run at end of T02 when page route exists)

## Inputs

- `src/lib/actions/workspaces.ts` — existing server actions file to extend with getWorkspaceAction
- `src/lib/workspaces/urls.ts` — buildWorkspaceUrls function for constructing tool URLs
- `src/lib/coder/types.ts` — CoderWorkspace type definition
- `src/lib/coder/client.ts` — CoderClient.getWorkspace method
- `src/components/ui/button.tsx` — Button component for UI

## Expected Output

- `src/lib/actions/workspaces.ts` — modified with new getWorkspaceAction export
- `src/components/workspaces/WorkspaceToolPanel.tsx` — new client component with iframe panels
  - Files: `src/components/workspaces/WorkspaceToolPanel.tsx`, `src/lib/actions/workspaces.ts`, `src/lib/workspaces/urls.ts`, `src/lib/coder/types.ts`, `src/lib/coder/client.ts`, `src/components/ui/button.tsx`
  - Verify: test -f src/components/workspaces/WorkspaceToolPanel.tsx && grep -q 'getWorkspaceAction' src/lib/actions/workspaces.ts && grep -q 'buildWorkspaceUrls' src/components/workspaces/WorkspaceToolPanel.tsx

- [x] **T02: Create workspace detail page route and wire list page navigation** `est:30m`
  ## Description

Connects T01's components into the app — creates the `/workspaces/[id]` server route and adds navigation from the workspace list page. Without this, the panel component has no page to live on and users can't reach it.

### What to build

**1. `/workspaces/[id]/page.tsx`** — async server component:
- Follow the exact pattern from `src/app/workspaces/[id]/terminal/page.tsx`
- Interface: `{ params: Promise<{ id: string }> }`
- Await params to get workspace ID
- Call `getWorkspaceAction({ workspaceId })` and `getWorkspaceAgentAction({ workspaceId })` in parallel via `Promise.all`
- Handle error: if `getWorkspaceAction` fails, show "Workspace not found" error page (same style as terminal page's "No agent found" error)
- If agent not found, still render the panel but with a fallback agent name of `'main'` (the convention from S01)
- Pass workspace data, agent name (from agent result or fallback 'main'), and `process.env.CODER_URL ?? ''` to `WorkspaceToolPanel`
- Add a back-link to `/workspaces` at the top of the page

**2. Update `WorkspacesClient.tsx`** — add navigation:
- Import `Link` from `next/link`
- Make the workspace name text a `<Link href={`/workspaces/${ws.id}`}>` so clicking the name navigates to the detail page
- Keep all existing tool link buttons (Filebrowser, KasmVNC, Dashboard, Terminal) as-is — they remain as quick-access shortcuts on the list page
- The workspace card click-to-expand behavior should still work (clicking the card row expands sessions, clicking the name navigates)
- To avoid the card click handler intercepting the link click, add `e.stopPropagation()` on the Link's click event

## Steps

1. Read `src/app/workspaces/[id]/terminal/page.tsx` for the exact server component pattern to follow
2. Read T01's outputs: `src/components/workspaces/WorkspaceToolPanel.tsx` and verify `getWorkspaceAction` in `src/lib/actions/workspaces.ts`
3. Create `src/app/workspaces/[id]/page.tsx` with the server component
4. Read `src/components/workspaces/WorkspacesClient.tsx` and add Link-based navigation on workspace names
5. Run `pnpm build` to verify the route compiles and is listed

## Must-Haves

- [ ] `/workspaces/[id]/page.tsx` exists as async server component
- [ ] Page fetches workspace data and agent info in parallel
- [ ] Error state renders when workspace not found
- [ ] WorkspaceToolPanel receives correct props (workspace, agentName, coderUrl)
- [ ] Workspace name in list page is a Link to `/workspaces/[id]`
- [ ] Back-link to /workspaces on detail page
- [ ] `pnpm build` succeeds

## Verification

- `test -f src/app/workspaces/\[id\]/page.tsx` — detail page exists
- `grep -q 'WorkspaceToolPanel' src/app/workspaces/\[id\]/page.tsx` — uses panel component
- `grep -q '/workspaces/' src/components/workspaces/WorkspacesClient.tsx` — link to detail page
- `pnpm build` — builds successfully

## Inputs

- `src/components/workspaces/WorkspaceToolPanel.tsx` — T01 output, the panel component to render
- `src/lib/actions/workspaces.ts` — T01 output with getWorkspaceAction
- `src/app/workspaces/[id]/terminal/page.tsx` — pattern reference for server component structure
- `src/components/workspaces/WorkspacesClient.tsx` — list page to add navigation links

## Expected Output

- `src/app/workspaces/[id]/page.tsx` — new server component for workspace detail route
- `src/components/workspaces/WorkspacesClient.tsx` — modified with Link navigation to detail page
  - Files: `src/app/workspaces/[id]/page.tsx`, `src/components/workspaces/WorkspacesClient.tsx`, `src/app/workspaces/[id]/terminal/page.tsx`, `src/lib/actions/workspaces.ts`, `src/components/workspaces/WorkspaceToolPanel.tsx`
  - Verify: test -f src/app/workspaces/\[id\]/page.tsx && grep -q 'WorkspaceToolPanel' src/app/workspaces/\[id\]/page.tsx && pnpm build

- [ ] **T03: Add unit tests for WorkspaceToolPanel and getWorkspaceAction** `est:30m`
  ## Description

Validates component behavior and the new server action without a running Coder instance. Tests cover tab switching, popup-out, error fallback, disabled state, and the getWorkspaceAction server action.

### What to test

**1. `workspace-tool-panel.test.tsx`** — component tests using @testing-library/react:
- Renders filebrowser iframe by default (check iframe src contains 'filebrowser')
- Tab switching: click kasmvnc tab, iframe src changes to kasmvnc URL
- Pop Out button calls `window.open` with the correct URL
- Dashboard link-out renders as anchor with correct href and `target="_blank"`
- Disabled state: when workspace status is 'stopped', renders message instead of iframe, tab buttons are disabled
- Error fallback: when error state is triggered, shows fallback link UI instead of iframe

**Mock strategy:**
- Mock `src/lib/workspaces/urls.ts` to return predictable URLs: `{ filebrowser: 'https://fb.test', kasmvnc: 'https://kasm.test', dashboard: 'https://dash.test' }`
- Mock `window.open` as `vi.fn()`
- Create a test workspace fixture matching `CoderWorkspace` type with `latest_build.status: 'running'`
- For disabled state test, use `latest_build.status: 'stopped'`

**2. Add to `actions.test.ts`** — server action test:
- Add test for `getWorkspaceAction`: mock `CoderClient.prototype.getWorkspace` to return a workspace object, call the action with a workspace ID, verify it returns the workspace
- Follow the existing test pattern in the file (vi.resetModules + dynamic import for module isolation)

## Steps

1. Read `src/__tests__/components/terminal-tab-manager.test.tsx` for the component testing pattern (mocking, rendering, assertions)
2. Read `src/__tests__/lib/workspaces/actions.test.ts` for the server action testing pattern
3. Read `src/components/workspaces/WorkspaceToolPanel.tsx` to understand the exact component API and DOM structure (data-testid attributes, element roles)
4. Create `src/__tests__/components/workspace-tool-panel.test.tsx` with 6-8 tests
5. Add 1-2 tests to `src/__tests__/lib/workspaces/actions.test.ts` for getWorkspaceAction
6. Run `pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx` to verify
7. Run `pnpm vitest run` to verify zero regressions

## Must-Haves

- [ ] WorkspaceToolPanel test file exists with 6+ passing tests
- [ ] Tests cover: default tab render, tab switching, popup-out, dashboard link, disabled state, error fallback
- [ ] getWorkspaceAction test added to existing actions test file
- [ ] Full test suite passes with zero regressions

## Negative Tests

- **Disabled state**: workspace with status 'stopped' — no iframe rendered, tabs disabled
- **Error fallback**: simulated iframe error state — fallback links shown instead of iframe
- **Missing coderUrl**: empty string coderUrl prop — component handles gracefully (no crash)

## Verification

- `pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx` — all tests pass
- `pnpm vitest run src/__tests__/lib/workspaces/actions.test.ts` — all tests pass (existing + new)
- `pnpm vitest run` — full suite passes, zero regressions

## Inputs

- `src/components/workspaces/WorkspaceToolPanel.tsx` — T01 output, component under test
- `src/lib/actions/workspaces.ts` — T01 output, server action under test
- `src/__tests__/components/terminal-tab-manager.test.tsx` — testing pattern reference
- `src/__tests__/lib/workspaces/actions.test.ts` — existing test file to extend
- `src/lib/coder/types.ts` — CoderWorkspace type for test fixtures

## Expected Output

- `src/__tests__/components/workspace-tool-panel.test.tsx` — new test file with 6+ tests
- `src/__tests__/lib/workspaces/actions.test.ts` — modified with getWorkspaceAction test
  - Files: `src/__tests__/components/workspace-tool-panel.test.tsx`, `src/__tests__/lib/workspaces/actions.test.ts`, `src/components/workspaces/WorkspaceToolPanel.tsx`, `src/lib/actions/workspaces.ts`, `src/__tests__/components/terminal-tab-manager.test.tsx`
  - Verify: pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx && pnpm vitest run src/__tests__/lib/workspaces/actions.test.ts && pnpm vitest run

## Files Likely Touched

- src/components/workspaces/WorkspaceToolPanel.tsx
- src/lib/actions/workspaces.ts
- src/lib/workspaces/urls.ts
- src/lib/coder/types.ts
- src/lib/coder/client.ts
- src/components/ui/button.tsx
- src/app/workspaces/[id]/page.tsx
- src/components/workspaces/WorkspacesClient.tsx
- src/app/workspaces/[id]/terminal/page.tsx
- src/__tests__/components/workspace-tool-panel.test.tsx
- src/__tests__/lib/workspaces/actions.test.ts
- src/__tests__/components/terminal-tab-manager.test.tsx
