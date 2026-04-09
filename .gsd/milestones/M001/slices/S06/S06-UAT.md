# S06: Live Agent Streaming & Dashboard Results — UAT

**Milestone:** M001
**Written:** 2026-03-20

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All deliverables are testable via unit tests with mocked child_process and component rendering. The slice plan explicitly states "Real runtime required: no" and "Human/UAT required: no". SSE streaming, workspace lookup, and UI rendering are all contract-tested.

## Preconditions

- Repository cloned and dependencies installed (`npm install`)
- No running services required — all tests use mocks
- Node.js 18+ (for Web Streams API support in tests)

## Smoke Test

Run `npx vitest run` — all 139 tests across 24 files must pass. This confirms S06 additions (35 new tests) and zero regressions on S01–S05 tests (104 tests).

## Test Cases

### 1. Stream primitive spawns coder ssh correctly

1. Run `npx vitest run src/__tests__/lib/workspace/stream.test.ts`
2. **Expected:** 6 tests pass — spawn receives correct args (`coder ssh <workspace> -- <command>`), stdout chunks are buffered and split on newlines, partial lines are held until complete, abort signal kills child process, buffer flushes on child exit.

### 2. SSE route handler returns correct event stream

1. Run `npx vitest run src/__tests__/app/tasks/stream-route.test.ts`
2. **Expected:** 5 tests pass — Response has `Content-Type: text/event-stream` and `Cache-Control: no-cache`, returns `event: status` with `{"status":"waiting"}` when no running workspace exists, relays streamed lines as `data:` events, sends `event: status` with `{"status":"ended"}` when stream closes, constructs workspace name as `hive-worker-{taskId.slice(0,8)}`.

### 3. Verification report card renders all outcome states

1. Run `npx vitest run src/__tests__/app/tasks/task-detail-results.test.ts`
2. **Expected:** 16 tests pass — outcomeVariant maps pass→default, fail→destructive, inconclusive→secondary; formatDuration handles seconds/minutes/zero; VerificationReportCard renders strategy badge, correct outcome badge color for all three states, formatted duration, logs collapsed by default, logs expand on click.

### 4. Agent stream panel connects to SSE and renders live output

1. Run `npx vitest run src/__tests__/app/tasks/agent-stream-panel.test.ts`
2. **Expected:** 8 tests pass — no EventSource created for non-running tasks, correct URL `/api/tasks/{id}/stream`, message events append lines to output, initial state shows "Connecting", error state shows "Error", EventSource closed on unmount, status event transitions to streaming, waiting status displays correctly.

### 5. S06 placeholder fully removed

1. Run `grep -r "future update" src/app/tasks/`
2. **Expected:** No matches (exit code 1). The S06 placeholder card in task-detail.tsx has been replaced with AgentStreamPanel.

### 6. Full regression check

1. Run `npx vitest run`
2. **Expected:** 139 tests pass across 24 files. Zero failures. All S01–S05 tests unaffected.

## Edge Cases

### Stream abort on browser disconnect

1. In stream.test.ts, the abort signal test verifies that calling `abort()` on the AbortController kills the child process via `childProcess.kill()`.
2. **Expected:** Child process is terminated, no zombie processes.

### SSE with no running workspace

1. In stream-route.test.ts, the "waiting" test verifies the route returns `event: status {"status":"waiting"}` when Prisma returns no workspace with status "running".
2. **Expected:** SSE connection stays open with waiting status, no error thrown.

### Verification report with missing data

1. In task-detail-results.test.ts, the integration test checks that VerificationReportCard is not rendered when `task.verificationReport` is null/undefined.
2. **Expected:** No report card in the DOM, no errors.

### Agent stream panel for non-running task

1. In agent-stream-panel.test.ts, the "done status" test verifies the component returns null when status is not "running".
2. **Expected:** No EventSource created, no DOM output.

## Failure Signals

- Any test file failing in `npx vitest run` — indicates regression or broken S06 code
- `grep -r "future update" src/app/tasks/` returning matches — placeholder not properly replaced
- TypeScript compilation errors in S06 files — type mismatches between VerificationReportData and actual DB schema
- Missing `@testing-library/react` or `jsdom` — devDependencies not installed

## Not Proven By This UAT

- **Live runtime streaming** — Tests use mocked child_process and EventSource. Real coder ssh streaming through Coder proxy is not tested (deferred to M001 e2e integration).
- **Pi RPC structured events** — The streaming shows raw text, not structured agent events. R014's full vision of pi-web-ui components is deferred.
- **Browser visual rendering** — Component tests verify DOM structure via testing-library, not visual appearance. CSS styling, scroll behavior, and responsive layout are not tested.
- **Concurrent stream connections** — Multiple browsers streaming the same task simultaneously is not tested.
- **Workspace name synchronization** — The SSE route's `hive-worker-{taskId.slice(0,8)}` naming must match the Coder client's naming, but this cross-module contract is not enforced by tests.

## Notes for Tester

- All S06 tests are self-contained with mocks — no Docker, no database, no running services needed.
- The `// @vitest-environment jsdom` directive in component test files switches those files to DOM mode. Global vitest config remains node-mode.
- Pre-existing TypeScript errors in `task-queue.ts` and `cleanup.ts` are from S04/S05 and unrelated to S06. They don't affect test execution.
