---
estimated_steps: 21
estimated_files: 2
skills_used: []
---

# T03: Add integration tests and verify end-to-end keep-alive flow

## Description

Write integration tests that verify the complete keep-alive flow: proxy with mocked Coder API receives connections, pings the extend endpoint on interval, accumulates failures when API returns errors, exposes correct status via HTTP endpoint, and resets on recovery. Also add a component test for KeepAliveWarning rendering behavior.

## Negative Tests

- **Error paths**: Coder API returns 401 (expired token) — verify failure counter increments and lastError captured; API returns 500 — same treatment; network timeout — same treatment
- **Boundary conditions**: Zero connections → no pings; exactly 3 failures → banner threshold; recovery after failures → counter resets to 0

## Steps

1. Create `services/terminal-proxy/src/__tests__/keepalive-integration.test.ts`: spin up a mock HTTP server simulating Coder's extend endpoint, instantiate ConnectionRegistry + KeepAliveManager pointing at mock server, add a connection, verify ping hits mock server within interval, simulate API failure (return 500), verify consecutiveFailures increments, simulate recovery (return 200), verify counter resets.
2. Add status endpoint test: start the real proxy HTTP server (or a minimal version), hit `GET /keepalive/status`, verify response shape `{workspaces: {[id]: {consecutiveFailures, lastSuccess, lastFailure}}}`.
3. Create `src/components/workspaces/__tests__/KeepAliveWarning.test.tsx`: render KeepAliveWarning with mocked useKeepAliveStatus returning various failure counts. Assert: renders nothing at 0, 1, 2 failures; renders Alert with destructive variant at 3+ failures; displays correct failure count in message.
4. Verify all existing terminal-proxy tests still pass (no regressions from proxy.ts changes).

## Must-Haves

- [ ] Integration test proves KeepAliveManager pings mock Coder API on interval
- [ ] Integration test proves failure counter increments on API error and resets on success
- [ ] Component test proves KeepAliveWarning renders nothing below threshold and destructive Alert at threshold
- [ ] All existing terminal-proxy tests pass without regression

## Verification

- `cd services/terminal-proxy && pnpm vitest run` — all proxy tests pass including new integration tests
- `pnpm vitest run src/components/workspaces/__tests__/KeepAliveWarning.test.tsx` — component tests pass

## Observability Impact

- Signals added: test coverage for failure-path logging (verifies [keep-alive] prefix appears in expected scenarios)
- How a future agent inspects this: run test suites to verify keep-alive behavior without manual Coder API access

## Inputs

- ``services/terminal-proxy/src/keepalive.ts` — T01 output with ConnectionRegistry and KeepAliveManager`
- ``services/terminal-proxy/src/index.ts` — T01 output with /keepalive/status endpoint`
- ``services/terminal-proxy/src/__tests__/keepalive.test.ts` — T01 output with unit tests (pattern to follow)`
- ``src/components/workspaces/KeepAliveWarning.tsx` — T02 output with warning banner component`
- ``src/hooks/useKeepAliveStatus.ts` — T02 output with polling hook`

## Expected Output

- ``services/terminal-proxy/src/__tests__/keepalive-integration.test.ts` — integration tests for KeepAliveManager with mock Coder API`
- ``src/components/workspaces/__tests__/KeepAliveWarning.test.tsx` — component tests for warning banner rendering thresholds`

## Verification

cd services/terminal-proxy && pnpm vitest run && cd /home/coder/hive && pnpm vitest run src/components/workspaces/__tests__/KeepAliveWarning.test.tsx
