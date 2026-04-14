---
estimated_steps: 29
estimated_files: 2
skills_used: []
---

# T04: Wire terminal connect buttons into workspace list and verify full integration

Connect the InteractiveTerminal into the existing workspace UI — add 'New Terminal' and per-session 'Connect' buttons to WorkspacesClient.tsx, wire them to navigate to the terminal page, and run full verification across the slice.

This task closes the integration loop: after T01-T03, the terminal infrastructure exists but isn't accessible from the workspace listing page. Users need to click a button on a workspace card to open a terminal session.

## Steps

1. Modify `src/components/workspaces/WorkspacesClient.tsx`:
   - Add a 'New Terminal' button on each running workspace card (next to existing Filebrowser/KasmVNC/Dashboard buttons)
   - The button navigates to `/workspaces/{workspaceId}/terminal` (using Next.js router)
   - Add per-tmux-session 'Connect' buttons in the expanded session panel that navigate to `/workspaces/{workspaceId}/terminal?session={sessionName}`
   - Disable terminal buttons for non-running workspaces (agent must be connected)
   - Use Terminal icon from lucide-react (already imported in WorkspacesClient.tsx)
2. Update `src/app/workspaces/[id]/terminal/page.tsx` to read optional `session` search param:
   - If `session` query param provided, use it as tmux session name
   - If not provided, default to `hive-main`
3. Run full slice verification:
   - `pnpm vitest run src/__tests__/lib/terminal/` — all protocol, proxy, and hook tests pass
   - `pnpm vitest run` — full test suite passes, zero regressions
   - `pnpm build` — succeeds with all new routes
   - Verify CODER_SESSION_TOKEN doesn't appear in any client component: `grep -rn 'CODER_SESSION_TOKEN' src/components/ src/hooks/ src/app/` should only match server components/actions

## Must-Haves

- [ ] 'New Terminal' button visible on running workspace cards
- [ ] Per-session 'Connect' buttons in expanded tmux session panel
- [ ] Terminal buttons disabled for non-running workspaces
- [ ] Session name passed via URL query parameter
- [ ] Full test suite passes with zero regressions
- [ ] CODER_SESSION_TOKEN not in any client-side code

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/` — all terminal tests pass
- `pnpm vitest run` — full suite passes (331+ tests, zero failures)
- `pnpm build` — succeeds
- `! grep -rn 'CODER_SESSION_TOKEN' src/components/ src/hooks/` — no matches (token is server-side only)

## Inputs

- ``src/components/workspaces/WorkspacesClient.tsx` — existing workspace list UI to extend`
- ``src/app/workspaces/[id]/terminal/page.tsx` — terminal page from T03`
- ``src/components/workspaces/InteractiveTerminal.tsx` — terminal component from T03`

## Expected Output

- ``src/components/workspaces/WorkspacesClient.tsx` — updated with terminal connect buttons`
- ``src/app/workspaces/[id]/terminal/page.tsx` — updated to accept session query param`

## Verification

pnpm vitest run && pnpm build
