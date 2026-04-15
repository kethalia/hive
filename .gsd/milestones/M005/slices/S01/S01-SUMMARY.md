---
id: S01
parent: M005
milestone: M005
provides:
  - ["workspace-list-page", "workspace-server-actions", "tmux-session-parser", "workspace-url-builder", "workspace-agent-status-types"]
requires:
  []
affects:
  - ["S02 (consumes workspace listing and session parser for terminal connection)", "S03 (extends workspace detail with multi-tab terminal UI)", "S04 (extends workspace detail with embedded Filebrowser/KasmVNC iframes)"]
key_files:
  - ["src/lib/workspaces/urls.ts", "src/lib/workspaces/sessions.ts", "src/lib/actions/workspaces.ts", "src/app/workspaces/page.tsx", "src/components/workspaces/WorkspacesClient.tsx", "src/lib/coder/types.ts", "src/components/app-sidebar.tsx"]
key_decisions:
  - ["Exported WorkspaceAgentStatus as named type for downstream status badge mapping", "Used getCoderClient() factory in server actions to defer env var access to call time", "Custom status badge spans instead of Badge component to avoid variant color conflicts with dynamic status colors", "Hardcoded agent name 'main' for client-side tool links — agent discovery requires server action", "Added force-dynamic to /tasks page to fix unrelated Prisma prerender failure"]
patterns_established:
  - ["Server component + client component pattern for workspace pages (same as /templates)", "getCoderClient() factory pattern for server actions needing Coder API access", "vi.resetModules() + dynamic import pattern for testing safe-action server actions in vitest"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-14T10:57:16.420Z
blocker_discovered: false
---

# S01: Workspace Discovery & Listing

**Built /workspaces page with live Coder workspace listing, status badges, lazy-loaded tmux sessions, external tool links, and sidebar navigation — 16 new tests, 331 total passing.**

## What Happened

## What This Slice Delivered

This slice establishes the workspace discovery layer for M005 — the entry point users need before they can interact with terminals. Three tasks delivered the full vertical: data layer, UI, and tests.

### T01: Data Layer & Navigation
Extended `CoderWorkspace` and `WorkspaceAgent` types with display fields and a proper status union type (`WorkspaceAgentStatus`). Created three new modules:
- `src/lib/workspaces/urls.ts` — `buildWorkspaceUrls()` constructs Filebrowser, KasmVNC, and Coder Dashboard URLs from workspace metadata and CODER_URL
- `src/lib/workspaces/sessions.ts` — `parseTmuxSessions()` parses tmux list-sessions output into typed `TmuxSession` objects
- `src/lib/actions/workspaces.ts` — Two server actions (`listWorkspacesAction`, `getWorkspaceSessionsAction`) using the established next-safe-action pattern with `getCoderClient()` factory for deferred env access

Added "Workspaces" to the sidebar nav with Monitor icon.

### T02: /workspaces Page UI
Created the page following the established templates page pattern — async server component with force-dynamic, passing initial data to a client component. The client component renders:
- Workspace card grid with colored status badges (green=running, yellow=starting/stopping, red=failed, gray=stopped)
- Click-to-expand tmux session panels (lazy-loaded, only for running workspaces)
- External tool link buttons (Filebrowser, KasmVNC, Dashboard) for running workspaces
- Refresh button, error banners, empty states, and loading spinners

Also fixed an unrelated build issue: added `force-dynamic` to `/tasks` page to prevent Prisma prerender failure.

### T03: Test Coverage
16 tests across 3 files covering the data layer:
- URL builder: standard inputs, trailing slash, path prefix, all three URL patterns (5 tests)
- Session parser: single/multiple sessions, empty input, malformed lines, trailing newlines (7 tests)
- Server actions: happy path listing, session fetch with parsed output, no-agents fallback, tmux error fallback (4 tests)

Used `vi.resetModules()` with dynamic imports to isolate server action tests from module-level safe-action context.

## Verification

## Verification Summary

| Check | Result |
|-------|--------|
| `pnpm build` | ✅ Pass — /workspaces route listed as dynamic |
| `pnpm vitest run src/__tests__/lib/workspaces/` | ✅ 16/16 tests pass (3 files) |
| `pnpm vitest run` | ✅ 331/331 tests pass (45 files), zero regressions |
| Sidebar contains "Workspaces" | ✅ Confirmed via grep |
| All source files exist | ✅ urls.ts, sessions.ts, actions/workspaces.ts, page.tsx, WorkspacesClient.tsx |
| CODER_SESSION_TOKEN not in client code | ✅ Server actions only — token accessed via process.env in server context |

## Requirements Advanced

- R035 — Workspace list page renders all owner workspaces with live status badges and lazy-loaded tmux sessions — full UI and data layer built, needs live Coder API for runtime validation

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Added `export const dynamic = 'force-dynamic'` to src/app/tasks/page.tsx — not in slice plan but required to fix build failure from Prisma DB unavailability at prerender time.

## Known Limitations

External tool links use hardcoded agent name 'main' instead of dynamically resolving the workspace agent name. This works for standard single-agent Coder workspaces but would need enhancement for multi-agent setups.

## Follow-ups

None.

## Files Created/Modified

- `src/lib/coder/types.ts` — Extended CoderWorkspace with display fields, refined WorkspaceAgent.status to union type
- `src/lib/workspaces/urls.ts` — New — buildWorkspaceUrls() for Filebrowser/KasmVNC/Dashboard URL construction
- `src/lib/workspaces/sessions.ts` — New — parseTmuxSessions() and TmuxSession type
- `src/lib/actions/workspaces.ts` — New — listWorkspacesAction and getWorkspaceSessionsAction server actions
- `src/components/app-sidebar.tsx` — Added Workspaces nav entry with Monitor icon
- `src/app/workspaces/page.tsx` — New — async server component for /workspaces route
- `src/components/workspaces/WorkspacesClient.tsx` — New — client component with workspace cards, status badges, sessions, tool links
- `src/app/tasks/page.tsx` — Added force-dynamic export to fix Prisma prerender failure
- `src/__tests__/lib/workspaces/urls.test.ts` — New — 5 tests for URL builder
- `src/__tests__/lib/workspaces/sessions.test.ts` — New — 7 tests for tmux session parser
- `src/__tests__/lib/workspaces/actions.test.ts` — New — 4 tests for workspace server actions
