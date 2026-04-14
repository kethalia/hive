---
estimated_steps: 3
estimated_files: 2
skills_used: []
---

# T01: Add tmux session create, rename, and kill server actions with unit tests

Add three new server actions to `src/lib/actions/workspaces.ts` following the existing `getWorkspaceSessionsAction` pattern: `createSessionAction` (creates a new tmux session with optional name, validates against SAFE_IDENTIFIER_RE, defaults to auto-generated name like `session-1`), `renameSessionAction` (renames existing tmux session via `tmux rename-session -t oldName newName`, validates both names), and `killSessionAction` (kills tmux session via `tmux kill-session -t name`). All three use `execInWorkspace` with the same zod-validated input pattern. Write unit tests in `src/__tests__/lib/actions/session-actions.test.ts` mocking `execInWorkspace` to verify correct tmux commands, SAFE_IDENTIFIER_RE validation rejection, and error handling for missing agents.

Context from S02: `execInWorkspace(agentTarget, command)` executes commands via `coder ssh`. `getWorkspaceSessionsAction` at line ~50 of workspaces.ts is the pattern to follow — zod schema for input, resolve agent via `getWorkspaceAgentAction`, call `execInWorkspace`, return parsed result. `SAFE_IDENTIFIER_RE` is imported from `src/lib/constants.ts` and must validate all session names.

R039 requires create (auto-named), rename, and kill from the dashboard. Auto-naming from cwd is deferred to a simple counter pattern (`session-1`, `session-2`) per research recommendation — cwd-based naming adds complexity for marginal UX benefit in v1.

## Inputs

- ``src/lib/actions/workspaces.ts` — existing server actions with getWorkspaceSessionsAction pattern`
- ``src/lib/constants.ts` — SAFE_IDENTIFIER_RE for session name validation`
- ``src/lib/workspaces/sessions.ts` — TmuxSession interface and parseTmuxSessions`

## Expected Output

- ``src/lib/actions/workspaces.ts` — three new exported server actions: createSessionAction, renameSessionAction, killSessionAction`
- ``src/__tests__/lib/actions/session-actions.test.ts` — unit tests for all three actions covering happy path, validation rejection, and error handling`

## Verification

pnpm vitest run src/__tests__/lib/actions/session-actions.test.ts && pnpm vitest run
