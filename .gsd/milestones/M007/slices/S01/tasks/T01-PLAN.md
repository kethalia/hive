---
estimated_steps: 3
estimated_files: 2
skills_used: []
---

# T01: Remove header and position floating sidebar trigger

Remove the `<header>` block from `layout.tsx` (lines 38-44) which contains SidebarTrigger, Separator, and HeaderContent. Reposition `SidebarTrigger` as a fixed floating button in the top-left corner (e.g. `fixed top-3 left-3 z-50`) outside the SidebarInset, so it's always visible regardless of sidebar state. Delete `HeaderContent.tsx` entirely — it renders breadcrumbs that are being removed per D029. Remove the `HeaderContent` and `Separator` imports from layout.tsx. Adjust `<main>` padding-top if needed so content doesn't sit under the floating trigger.

The SidebarTrigger must remain inside the SidebarProvider so it can toggle the sidebar. Place it as a sibling of SidebarInset, after AppSidebar.

R062 requires header and breadcrumbs removed from ALL pages with only the floating trigger remaining.

## Inputs

- ``src/app/layout.tsx` — current root layout with header block on lines 38-44`
- ``src/components/HeaderContent.tsx` — breadcrumb component to be deleted`
- ``src/components/ui/sidebar.tsx` — SidebarTrigger component (no changes needed, reference only)`

## Expected Output

- ``src/app/layout.tsx` — header block removed, SidebarTrigger repositioned as fixed floating element, Separator and HeaderContent imports removed`
- ``src/components/HeaderContent.tsx` — deleted`

## Verification

grep -qv '<header' src/app/layout.tsx && ! test -f src/components/HeaderContent.tsx && pnpm tsc --noEmit
