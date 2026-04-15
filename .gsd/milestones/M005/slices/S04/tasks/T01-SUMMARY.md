---
id: T01
parent: S04
milestone: M005
key_files:
  - src/lib/actions/workspaces.ts
  - src/components/workspaces/WorkspaceToolPanel.tsx
key_decisions:
  - Used buttonVariants() with anchor tags for link buttons instead of asChild (not supported by base-ui Button)
  - Used setTimeout + cross-origin contentWindow access check for iframe error detection rather than onError alone (onError doesn't fire for cross-origin blocks)
duration: 
verification_result: passed
completed_at: 2026-04-14T11:41:38.504Z
blocker_discovered: false
---

# T01: Add getWorkspaceAction server action and WorkspaceToolPanel iframe component with tab toggle, pop-out, dashboard link, disabled state, and error fallback

**Add getWorkspaceAction server action and WorkspaceToolPanel iframe component with tab toggle, pop-out, dashboard link, disabled state, and error fallback**

## What Happened

Added `getWorkspaceAction` to `src/lib/actions/workspaces.ts` following the existing pattern — Zod-validated `workspaceId` input, `actionClient` wrapper, delegates to `client.getWorkspace()`.

Created `WorkspaceToolPanel` client component at `src/components/workspaces/WorkspaceToolPanel.tsx` with all required features:
- Two-tab toggle (filebrowser/kasmvnc) using `useState`, with active tab getting `default` variant styling and inactive getting `outline`
- Iframe renders with `src` from `buildWorkspaceUrls()`, keyed on `activeUrl` so it remounts on tab switch
- Pop Out button calls `window.open(activeUrl, '_blank')`
- Coder Dashboard link-out using `<a>` with `buttonVariants` styling (the project's Button component doesn't support `asChild`)
- Disabled state: when `workspace.latest_build.status !== 'running'`, shows status message with grayed-out tab buttons and no iframe
- Error fallback: 4-second `setTimeout` after iframe mount attempts cross-origin `contentWindow` access — if it throws, sets error state and shows fallback UI with direct link buttons for both tools
- Lucide icons: `FolderOpen`, `Monitor`, `ExternalLink`, `LayoutDashboard`

## Verification

All task verification checks passed:
- `getWorkspaceAction` exists in workspaces.ts
- WorkspaceToolPanel.tsx created with `buildWorkspaceUrls` and `window.open`
- TypeScript type check passes with zero errors in the new/modified files

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -f src/components/workspaces/WorkspaceToolPanel.tsx` | 0 | ✅ pass | 10ms |
| 2 | `grep -q 'getWorkspaceAction' src/lib/actions/workspaces.ts` | 0 | ✅ pass | 10ms |
| 3 | `grep -q 'buildWorkspaceUrls' src/components/workspaces/WorkspaceToolPanel.tsx` | 0 | ✅ pass | 10ms |
| 4 | `grep -q 'window.open' src/components/workspaces/WorkspaceToolPanel.tsx` | 0 | ✅ pass | 10ms |
| 5 | `pnpm exec tsc --noEmit 2>&1 | grep WorkspaceToolPanel` | 1 | ✅ pass (no TS errors in component) | 45000ms |

## Deviations

Replaced `asChild` prop pattern (from task plan) with `buttonVariants()` on `<a>` tags — the project's Button component uses base-ui which doesn't expose `asChild`. This is the established pattern in the codebase (see app-sidebar.tsx).

## Known Issues

pnpm build deferred to T02 when the page route exists (per task plan). Pre-existing TS errors in council-queues.ts and test files are unrelated to this task.

## Files Created/Modified

- `src/lib/actions/workspaces.ts`
- `src/components/workspaces/WorkspaceToolPanel.tsx`
