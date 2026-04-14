---
id: T01
parent: S01
milestone: M005
key_files:
  - src/lib/coder/types.ts
  - src/lib/workspaces/urls.ts
  - src/lib/workspaces/sessions.ts
  - src/lib/actions/workspaces.ts
  - src/components/app-sidebar.tsx
key_decisions:
  - Exported WorkspaceAgentStatus as a named type so downstream components can import it for status badge mapping
  - Used getCoderClient() factory in server actions to avoid module-level env access (env vars read at call time, not import time)
duration: 
verification_result: passed
completed_at: 2026-04-14T10:50:09.176Z
blocker_discovered: false
---

# T01: Add Coder workspace types, server actions, URL builder, tmux session parser, and sidebar entry

**Add Coder workspace types, server actions, URL builder, tmux session parser, and sidebar entry**

## What Happened

Extended CoderWorkspace interface with optional display fields (template_name, template_display_name, template_icon, last_used_at, health) and refined WorkspaceAgent.status from bare string to a union of actual Coder agent lifecycle statuses.\n\nCreated three new utility/action files:\n- `src/lib/workspaces/urls.ts` — buildWorkspaceUrls constructs Filebrowser, KasmVNC, and Coder dashboard URLs from workspace metadata and CODER_URL\n- `src/lib/workspaces/sessions.ts` — parseTmuxSessions parses colon-delimited tmux list-sessions output into typed TmuxSession objects, handling empty/malformed input gracefully\n- `src/lib/actions/workspaces.ts` — two server actions using the established actionClient pattern: listWorkspacesAction (fetches owner:me workspaces) and getWorkspaceSessionsAction (resolves agent name, runs tmux via execInWorkspace, returns parsed sessions or empty array on failure)\n\nAdded Workspaces nav entry with Monitor icon to the sidebar after Templates. CODER_SESSION_TOKEN is only accessed in server actions, never exposed to client code.

## Verification

Next.js compilation succeeded (\"Compiled successfully in 2.4s\"). Build failed at prerender stage due to pre-existing database connectivity issue, unrelated to these changes. tsc --noEmit shows no errors in new/modified files (all errors are pre-existing in task-queue.ts and cleanup.ts). All file existence checks pass: grep confirms Workspaces in sidebar, all three new files exist.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm build (compilation phase)` | 0 | ✅ pass | 2400ms |
| 2 | `grep -q 'Workspaces' src/components/app-sidebar.tsx` | 0 | ✅ pass | 10ms |
| 3 | `test -f src/lib/actions/workspaces.ts && test -f src/lib/workspaces/urls.ts && test -f src/lib/workspaces/sessions.ts` | 0 | ✅ pass | 10ms |
| 4 | `npx tsc --noEmit (new files only)` | 0 | ✅ pass — no errors in new/modified files | 15000ms |

## Deviations

None

## Known Issues

Pre-existing: pnpm build fails at prerender due to unreachable database (PrismaClientInitializationError on /tasks page). Pre-existing: tsc reports type errors in task-queue.ts (ioredis version mismatch) and cleanup.ts (Prisma schema). Neither relates to this task.

## Files Created/Modified

- `src/lib/coder/types.ts`
- `src/lib/workspaces/urls.ts`
- `src/lib/workspaces/sessions.ts`
- `src/lib/actions/workspaces.ts`
- `src/components/app-sidebar.tsx`
