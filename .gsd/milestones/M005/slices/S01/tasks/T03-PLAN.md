---
estimated_steps: 25
estimated_files: 3
skills_used: []
---

# T03: Add tests for workspace URL builder, tmux session parser, and server actions

This task adds unit tests covering the data layer introduced in T01. Tests follow the existing pattern in `src/__tests__/lib/coder/client.test.ts` — using vitest with vi.fn() for fetch mocking. The tests cover the URL builder, tmux session parser, and server action error handling.

## Steps

1. Create `src/__tests__/lib/workspaces/urls.test.ts`:
   - Test `buildWorkspaceUrls` with standard inputs: workspace name, owner, agent name, CODER_URL
   - Test URL construction for each tool: filebrowser follows `https://filebrowser--{agent}--{workspace}--{owner}.{coder_host}` pattern
   - Test with CODER_URL that has trailing slash
   - Test with CODER_URL that has path prefix
   - Test dashboard URL is `{CODER_URL}/@{owner}/{workspace}`

2. Create `src/__tests__/lib/workspaces/sessions.test.ts`:
   - Test `parseTmuxSessions` with single session line: `main:1712345678:3` → `{ name: 'main', created: 1712345678, windows: 3 }`
   - Test with multiple sessions (multi-line input)
   - Test with empty string input → empty array
   - Test with malformed lines (missing fields, non-numeric) → skipped gracefully
   - Test with trailing newline

3. Create `src/__tests__/lib/workspaces/actions.test.ts`:
   - Mock CoderClient and execInWorkspace
   - Test listWorkspacesAction returns workspace list from CoderClient
   - Test getWorkspaceSessionsAction with running workspace returns parsed sessions
   - Test getWorkspaceSessionsAction with workspace that has no agents returns empty array
   - Test getWorkspaceSessionsAction when tmux returns exit code 1 (no sessions) returns empty array

## Must-Haves

- [ ] URL builder tests cover all three tool URL patterns
- [ ] Session parser tests cover empty, single, multiple, and malformed inputs
- [ ] Action tests cover happy path and error paths
- [ ] All tests pass with `pnpm vitest run src/__tests__/lib/workspaces/`

## Inputs

- ``src/lib/workspaces/urls.ts` — buildWorkspaceUrls function to test`
- ``src/lib/workspaces/sessions.ts` — parseTmuxSessions function to test`
- ``src/lib/actions/workspaces.ts` — server actions to test`
- ``src/__tests__/lib/coder/client.test.ts` — reference test pattern (vitest, fetch mocking)`

## Expected Output

- ``src/__tests__/lib/workspaces/urls.test.ts` — URL builder unit tests`
- ``src/__tests__/lib/workspaces/sessions.test.ts` — tmux parser unit tests`
- ``src/__tests__/lib/workspaces/actions.test.ts` — server action tests with mocked dependencies`

## Verification

pnpm vitest run src/__tests__/lib/workspaces/ && pnpm vitest run
