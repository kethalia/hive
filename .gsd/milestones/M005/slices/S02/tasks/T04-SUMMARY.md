---
id: T04
parent: S02
milestone: M005
key_files:
  - src/components/workspaces/WorkspacesClient.tsx
  - src/app/workspaces/[id]/terminal/page.tsx
  - src/app/workspaces/[id]/terminal/terminal-client.tsx
key_decisions:
  - Use existing conditional rendering (status === 'running') to disable terminal buttons for non-running workspaces rather than adding explicit disabled prop — simpler, no visual disabled state needed since buttons don't render at all
  - Use encodeURIComponent for session name in URL to handle special characters safely
duration: 
verification_result: passed
completed_at: 2026-04-14T11:16:14.501Z
blocker_discovered: false
---

# T04: Wire terminal connect buttons into workspace list with per-session navigation and session query param support

**Wire terminal connect buttons into workspace list with per-session navigation and session query param support**

## What Happened

Added terminal access buttons to the workspace list UI and wired the terminal page to accept a session query parameter.

In WorkspacesClient.tsx: added a "New Terminal" button (using the existing Terminal icon from lucide-react) to each running workspace's tool links bar, navigating to `/workspaces/{id}/terminal` via Next.js router. In the expanded tmux sessions panel, added a "Connect" button per session that navigates to `/workspaces/{id}/terminal?session={sessionName}` with proper URI encoding. Both button types are only rendered when the workspace status is "running", satisfying the disabled-for-non-running requirement inherently through the existing conditional rendering.

Updated the terminal page route (`page.tsx`) to accept an optional `session` search param via Next.js 16's `searchParams` Promise prop, passing it through to `TerminalClient`. Updated `terminal-client.tsx` to accept `sessionName` as a prop instead of hardcoding `"hive-main"`. When no session param is provided, defaults to `"hive-main"`.

All 375 tests pass with zero regressions. Build succeeds. CODER_SESSION_TOKEN confirmed absent from all client-side code.

## Verification

1. `pnpm vitest run src/__tests__/lib/terminal/` — all 44 terminal tests pass (protocol, proxy, hooks)
2. `pnpm vitest run` — full suite passes: 375 tests, 48 files, zero failures
3. `pnpm build` — succeeds, terminal route at `/workspaces/[id]/terminal` visible in route table
4. `grep -rn 'CODER_SESSION_TOKEN' src/components/ src/hooks/ src/app/` — no matches, token is server-side only

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/terminal/` | 0 | pass | 194ms |
| 2 | `pnpm vitest run` | 0 | pass | 2390ms |
| 3 | `pnpm build` | 0 | pass | 12000ms |
| 4 | `grep -rn 'CODER_SESSION_TOKEN' src/components/ src/hooks/ src/app/` | 1 | pass | 50ms |

## Deviations

none

## Known Issues

none

## Files Created/Modified

- `src/components/workspaces/WorkspacesClient.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
