---
estimated_steps: 47
estimated_files: 6
skills_used: []
---

# T01: Build WorkspaceToolPanel component and add getWorkspaceAction server action

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

## Inputs

- `src/lib/actions/workspaces.ts`
- `src/lib/workspaces/urls.ts`
- `src/lib/coder/types.ts`
- `src/lib/coder/client.ts`
- `src/components/ui/button.tsx`

## Expected Output

- `src/lib/actions/workspaces.ts`
- `src/components/workspaces/WorkspaceToolPanel.tsx`

## Verification

test -f src/components/workspaces/WorkspaceToolPanel.tsx && grep -q 'getWorkspaceAction' src/lib/actions/workspaces.ts && grep -q 'buildWorkspaceUrls' src/components/workspaces/WorkspaceToolPanel.tsx
