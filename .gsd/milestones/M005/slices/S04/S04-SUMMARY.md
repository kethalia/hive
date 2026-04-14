---
id: S04
parent: M005
milestone: M005
provides:
  - ["workspace-detail-page", "iframe-tool-panels", "getWorkspaceAction-server-action"]
requires:
  []
affects:
  []
key_files:
  - ["src/components/workspaces/WorkspaceToolPanel.tsx", "src/app/workspaces/[id]/page.tsx", "src/lib/actions/workspaces.ts", "src/components/workspaces/WorkspacesClient.tsx", "src/__tests__/components/workspace-tool-panel.test.tsx"]
key_decisions:
  - ["Used buttonVariants() on anchor tags for link buttons — Base UI Button doesn't support asChild (D020 confirmed)", "Cross-origin iframe error detection via setTimeout + contentWindow access check — onError doesn't fire for X-Frame-Options blocks", "Breadcrumb-style navigation on detail page instead of standalone back button", "Workspace name wrapped in Link with stopPropagation to preserve card expand/collapse behavior"]
patterns_established:
  - ["Server component fetches workspace + agent data in parallel, client component handles interactive state", "Cross-origin iframe error detection pattern for embedding external tools", "buttonVariants() on anchor tags for styled link buttons in Base UI"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-14T11:47:33.540Z
blocker_discovered: false
---

# S04: External Tool Integration

**Workspace detail page at /workspaces/[id] with iframe-embedded Filebrowser and KasmVNC panels, popup-out buttons, Coder Dashboard link-out, error fallback, and disabled state for non-running workspaces.**

## What Happened

## What Was Built

Three tasks delivered the complete external tool integration for the workspace detail page:

**T01 — WorkspaceToolPanel component and getWorkspaceAction server action.** Added `getWorkspaceAction` to `src/lib/actions/workspaces.ts` following the existing Zod-validated action pattern. Created `WorkspaceToolPanel` as a client component with: two-tab toggle (Filebrowser/KasmVNC) via useState, iframe rendering keyed on active URL, Pop Out button calling `window.open()`, Coder Dashboard link-out using `buttonVariants()` on anchor tags, iframe error detection via setTimeout + cross-origin contentWindow access check, and disabled state for non-running workspaces showing a status message with no iframe.

**T02 — Workspace detail page route and list page navigation.** Created `/workspaces/[id]/page.tsx` as an async server component following the terminal page pattern — awaits params, fetches workspace and agent data in parallel via Promise.all, handles error states, falls back to agent name 'main' if no agent found. Added breadcrumb-style back navigation to /workspaces. Updated `WorkspacesClient.tsx` to wrap workspace names in Next.js Link components with stopPropagation to preserve existing card expand/collapse behavior.

**T03 — Unit tests.** Created 8 tests for WorkspaceToolPanel (default tab render, tab switching, popup-out, dashboard link, disabled state, error fallback, dashboard in disabled state, empty coderUrl handling) and 2 tests for getWorkspaceAction (happy path + error propagation). Used Object.defineProperty on iframe contentWindow to simulate cross-origin block for error fallback testing. Total test count: 407 across 51 files, zero regressions.

## Key Patterns

- Cross-origin iframe error detection uses setTimeout + contentWindow access check rather than onError (which doesn't fire for X-Frame-Options blocks)
- `buttonVariants()` on anchor tags for link buttons (Base UI Button doesn't support asChild)
- Server component fetches workspace + agent data in parallel, client component handles all interactive state

## Verification

## Verification Results

All slice-level checks passed:

| Check | Result |
|-------|--------|
| `test -f src/components/workspaces/WorkspaceToolPanel.tsx` | PASS |
| `grep -q 'getWorkspaceAction' src/lib/actions/workspaces.ts` | PASS |
| `grep -q 'buildWorkspaceUrls' src/components/workspaces/WorkspaceToolPanel.tsx` | PASS |
| `grep -q 'window.open' src/components/workspaces/WorkspaceToolPanel.tsx` | PASS |
| `test -f src/app/workspaces/[id]/page.tsx` | PASS |
| `grep -q 'WorkspaceToolPanel' src/app/workspaces/[id]/page.tsx` | PASS |
| `grep -q '/workspaces/' src/components/workspaces/WorkspacesClient.tsx` | PASS |
| `pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx` | PASS — 8/8 tests |
| `pnpm vitest run src/__tests__/lib/workspaces/actions.test.ts` | PASS — 6/6 tests |
| `pnpm vitest run` | PASS — 407/407 tests, 51 files, 0 regressions |
| `pnpm build` | PASS — /workspaces/[id] route listed |

## Requirements Advanced

None.

## Requirements Validated

- R040 — WorkspaceToolPanel renders iframe-embedded Filebrowser and KasmVNC with tab toggle, popup-out buttons, Coder Dashboard link-out, error fallback, and disabled state. 8 component tests + build verification pass.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

Iframe error detection relies on setTimeout (4s delay) — cannot distinguish between slow-loading iframes and blocked iframes during that window. Real iframe embedding requires Coder subdomain apps to allow framing (X-Frame-Options must not be DENY). UAT requires live Coder workspace with Filebrowser and KasmVNC apps configured.

## Follow-ups

None.

## Files Created/Modified

- `src/components/workspaces/WorkspaceToolPanel.tsx` — New client component with iframe panels, tab toggle, popup-out, error fallback, disabled state
- `src/app/workspaces/[id]/page.tsx` — New async server component for workspace detail route
- `src/lib/actions/workspaces.ts` — Added getWorkspaceAction server action
- `src/components/workspaces/WorkspacesClient.tsx` — Added Link navigation on workspace names to detail page
- `src/__tests__/components/workspace-tool-panel.test.tsx` — New test file with 8 component tests
- `src/__tests__/lib/workspaces/actions.test.ts` — Added 2 tests for getWorkspaceAction
