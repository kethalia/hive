---
id: T02
parent: S01
milestone: M001
provides:
  - Typed CoderClient class with createWorkspace, getWorkspace, stopWorkspace, deleteWorkspace, waitForBuild methods
  - TypeScript interfaces for all Coder REST API request/response shapes
  - Comprehensive unit tests with mocked fetch (8 tests)
key_files:
  - lib/coder/types.ts
  - lib/coder/client.ts
  - __tests__/lib/coder/client.test.ts
key_decisions:
  - "Response objects can only have their body read once — mock fetch with mockImplementation returning fresh Response per call, not mockResolvedValue with a shared Response"
patterns_established:
  - "CoderClient wraps raw fetch with Coder-Session-Token header injection and structured error messages including HTTP status + body"
  - "waitForBuild uses exponential backoff (1s start, 5s cap) with immediate throw on 'failed' status"
  - "Structured console.log with [coder] prefix for all client operations"
observability_surfaces:
  - "[coder] prefix console logs for workspace create/stop/delete/poll operations"
  - "Error messages include HTTP status code + response body text for debugging"
  - "waitForBuild logs each poll iteration with current status"
  - "sessionToken never appears in logs — only used in request headers"
duration: 5m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T02: Implement typed Coder REST API client with unit tests

**Built typed CoderClient class wrapping raw fetch with session token auth, CRUD methods for Coder workspaces, and exponential-backoff polling — all 8 unit tests passing with mocked fetch.**

## What Happened

Created three files implementing the Coder REST API client:

1. **`lib/coder/types.ts`** — TypeScript interfaces for CoderWorkspace, CreateWorkspaceRequest, WorkspaceBuildRequest, CoderClientConfig, and WaitForBuildOptions. WorkspaceBuildStatus is a union of all 10 possible Coder build states matching the API.

2. **`lib/coder/client.ts`** — CoderClient class with a private `request()` helper that adds `Coder-Session-Token` and `Content-Type: application/json` headers, throwing descriptive errors on non-2xx (including status code + body). Public methods: `createWorkspace` (transforms Record<string,string> params into rich_parameter_values array), `getWorkspace`, `stopWorkspace`, `deleteWorkspace`, and `waitForBuild` (exponential backoff from 1s to 5s max, 120s default timeout, immediate throw on 'failed' status).

3. **`__tests__/lib/coder/client.test.ts`** — 8 tests covering all methods + error paths using vi.fn() to mock global fetch. One fix applied during implementation: the timeout test initially used `mockResolvedValue` with a shared Response object, but Response bodies can only be read once — switched to `mockImplementation` returning a fresh Response per call.

## Verification

- `npx vitest run __tests__/lib/coder/client.test.ts` — 8/8 tests pass
- `npx vitest run` — 13/13 tests pass (8 new + 5 from T01, no regressions)
- Test coverage: createWorkspace (URL, method, headers, body shape), getWorkspace (URL, return), stopWorkspace (transition:stop), deleteWorkspace (transition:delete), waitForBuild success (polls then resolves), waitForBuild timeout (throws after deadline), waitForBuild failure (throws on failed status), error handling (500 → descriptive error)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run __tests__/lib/coder/client.test.ts` | 0 | ✅ pass | 0.2s |
| 2 | `npx vitest run` | 0 | ✅ pass | 0.3s |

## Diagnostics

- **Test inspection:** `npx vitest run __tests__/lib/coder/client.test.ts` reruns all Coder client tests
- **Type checking:** `npx tsc --noEmit lib/coder/client.ts lib/coder/types.ts` verifies type correctness
- **Log grep:** Runtime logs use `[coder]` prefix — grep for `[coder]` in application output to trace all Coder API interactions
- **Error shape:** All Coder API errors include `[coder] Request failed: {status} {statusText} — {body}` for debugging

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `lib/coder/types.ts` — TypeScript interfaces for Coder API shapes (CoderWorkspace, CreateWorkspaceRequest, WorkspaceBuildRequest, CoderClientConfig, WaitForBuildOptions)
- `lib/coder/client.ts` — CoderClient class with createWorkspace, getWorkspace, stopWorkspace, deleteWorkspace, waitForBuild methods
- `__tests__/lib/coder/client.test.ts` — 8 unit tests covering all methods and error paths with mocked fetch
- `.gsd/milestones/M001/slices/S01/tasks/T02-PLAN.md` — Added Observability Impact section per pre-flight requirement
