---
id: T01
parent: S01
milestone: M007
key_files:
  - src/app/layout.tsx
  - src/components/HeaderContent.tsx (deleted)
key_decisions:
  - Placed SidebarTrigger as sibling after AppSidebar (before SidebarInset) so it remains inside SidebarProvider but outside the inset content area
  - Used pt-14 on main to offset content below the fixed trigger
duration: 
verification_result: passed
completed_at: 2026-04-17T05:01:09.213Z
blocker_discovered: false
---

# T01: Removed header/breadcrumbs from layout and repositioned SidebarTrigger as fixed floating button

**Removed header/breadcrumbs from layout and repositioned SidebarTrigger as fixed floating button**

## What Happened

Removed the `<header>` block (lines 38-44) from `src/app/layout.tsx` containing SidebarTrigger, Separator, and HeaderContent. Deleted `src/components/HeaderContent.tsx` entirely (breadcrumb component removed per D029/R062). Removed unused imports for `Separator`, `HeaderContent`, and `Suspense`. Repositioned `SidebarTrigger` as a sibling of `SidebarInset` (still inside `SidebarProvider`) with `fixed top-3 left-3 z-50` classes so it floats in the top-left corner regardless of sidebar state. Added `pt-14` to `<main>` so page content doesn't sit under the floating trigger. Confirmed no other files import HeaderContent.

## Verification

Ran grep to confirm no `<header` tag in layout.tsx, confirmed HeaderContent.tsx deleted, ran `pnpm tsc --noEmit` — all errors are pre-existing (ioredis version mismatch, prisma types in queue files), none related to this change.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -qv '<header' src/app/layout.tsx && ! test -f src/components/HeaderContent.tsx` | 0 | ✅ pass | 50ms |
| 2 | `pnpm tsc --noEmit` | 2 | ✅ pass (all errors pre-existing in queue/prisma files, none from this change) | 12000ms |

## Deviations

None

## Known Issues

Pre-existing TS errors in council-queues.ts, task-queue.ts, and cleanup.ts (ioredis version mismatch and prisma type issues) — unrelated to this task.

## Files Created/Modified

- `src/app/layout.tsx`
- `src/components/HeaderContent.tsx (deleted)`
