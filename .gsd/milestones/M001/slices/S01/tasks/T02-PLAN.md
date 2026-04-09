---
estimated_steps: 4
estimated_files: 3
---

# T02: Implement typed Coder REST API client with unit tests

**Slice:** S01 — Infrastructure & Orchestrator Core
**Milestone:** M001

## Description

Build a typed TypeScript client for the Coder REST API. No TypeScript SDK exists for Coder, so this wraps raw `fetch` with proper types, auth headers, and a polling utility for workspace build status. This is the highest-risk piece in the slice because it integrates with an external API. All tests use mocked fetch so no Coder instance is needed. Covers requirement R002 (orchestrator creates isolated Coder workspaces via REST API with task parameters).

## Steps

1. **Define Coder API types** — Create `lib/coder/types.ts` with TypeScript interfaces:
   - `CoderWorkspace` — id (string), name (string), latest_build ({ id, status: 'pending'|'starting'|'running'|'stopping'|'stopped'|'deleting'|'deleted'|'canceling'|'canceled'|'failed', job: { status: string, error: string } }), template_id (string), owner_name (string)
   - `CreateWorkspaceRequest` — name (string), template_id (string), rich_parameter_values (Array<{ name: string, value: string }>), template_version_id? (string)
   - `WorkspaceBuildRequest` — transition: 'start' | 'stop' | 'delete'
   - `CoderClientConfig` — baseUrl (string), sessionToken (string)

2. **Implement CoderClient class** — Create `lib/coder/client.ts`:
   - Constructor takes `CoderClientConfig`
   - Private `fetch` helper that adds `Coder-Session-Token` header and `Content-Type: application/json`, throws on non-2xx with status + body
   - `createWorkspace(templateId: string, name: string, params: Record<string, string>)` — POST to `/api/v2/organizations/default/members/me/workspaces`, transforms params Record into `rich_parameter_values` array, returns `CoderWorkspace`
   - `getWorkspace(workspaceId: string)` — GET `/api/v2/workspaces/{id}`, returns `CoderWorkspace`
   - `stopWorkspace(workspaceId: string)` — POST `/api/v2/workspaces/{id}/builds` with `{ transition: 'stop' }`
   - `deleteWorkspace(workspaceId: string)` — POST `/api/v2/workspaces/{id}/builds` with `{ transition: 'delete' }`
   - `waitForBuild(workspaceId: string, targetStatus: string, opts?: { timeoutMs?: number, intervalMs?: number })` — Polls `getWorkspace` with exponential backoff (start 1s, max 5s). Returns workspace when `latest_build.status === targetStatus`. Throws on timeout (default 120s) or if status is 'failed'. Log each poll with `[coder] Waiting for workspace ${id}: ${currentStatus}`.

3. **Write unit tests** — Create `__tests__/lib/coder/client.test.ts`:
   - Mock global `fetch` using `vi.fn()`
   - Test `createWorkspace`: verify correct URL, method, headers, body shape (rich_parameter_values transformed from Record), returns parsed response
   - Test `getWorkspace`: verify URL construction, returns workspace object
   - Test `stopWorkspace`: verify builds endpoint called with transition:'stop'
   - Test `deleteWorkspace`: verify builds endpoint called with transition:'delete'
   - Test `waitForBuild` success: mock getWorkspace returning 'starting' then 'running', verify it resolves
   - Test `waitForBuild` timeout: mock getWorkspace always returning 'starting', verify it throws timeout error
   - Test `waitForBuild` failure: mock getWorkspace returning 'failed', verify it throws immediately
   - Test error handling: mock fetch returning 500, verify descriptive error thrown with status code

4. **Verify** — Run `npx vitest run __tests__/lib/coder/client.test.ts` and confirm all tests pass.

## Must-Haves

- [ ] `CoderClient` class with createWorkspace, getWorkspace, stopWorkspace, deleteWorkspace, waitForBuild methods
- [ ] All requests include `Coder-Session-Token` header
- [ ] `createWorkspace` transforms Record<string,string> params into `rich_parameter_values` array format
- [ ] `waitForBuild` uses exponential backoff, throws on timeout or failed status
- [ ] Comprehensive unit tests with mocked fetch — no real Coder instance needed
- [ ] Error responses include HTTP status code and response body for debugging

## Verification

- `npx vitest run __tests__/lib/coder/client.test.ts` — all tests pass
- Test coverage: create, get, stop, delete, poll-success, poll-timeout, poll-failure, error-handling

## Observability Impact

- **New structured logs:** `[coder] Creating workspace ...`, `[coder] Stopping workspace ...`, `[coder] Deleting workspace ...`, `[coder] Waiting for workspace ${id}: ${status}` — all console.log with `[coder]` prefix for grep-ability
- **Error shape:** Failed API requests throw errors containing HTTP status code + response body text (e.g. `[coder] Request failed: 500 Internal Server Error — {"message":"..."}`)
- **Failure visibility:** `waitForBuild` throws immediately on `failed` status with the build job error message; timeout errors include workspace ID and target status
- **Inspection:** No persistent state added — this is a pure API client. Inspect via caller logs or by checking Coder API directly
- **Redaction:** `sessionToken` is only used in request headers, never logged

## Inputs

- `lib/db/schema.ts` — workspace status enum values (from T01) to keep status naming consistent
- `vitest.config.ts` — test framework configuration (from T01)

## Expected Output

- `lib/coder/types.ts` — TypeScript interfaces for all Coder API request/response shapes
- `lib/coder/client.ts` — Fully typed CoderClient class with all CRUD + polling methods
- `__tests__/lib/coder/client.test.ts` — 8+ unit tests covering all methods and error paths
