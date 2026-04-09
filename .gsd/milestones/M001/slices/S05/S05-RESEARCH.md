# S05: Verifier Template & Proof-by-Consumption — Research

**Date:** 2026-03-20

## Summary

S05 builds the verification subsystem: after a worker creates a PR, a verifier workspace spins up, pulls the branch, detects what kind of output was produced, and tests it by actually consuming it — browser-testing web apps, importing SDK exports, running test suites. The verification report gets stored in Postgres and exposed via API.

The codebase is well-prepared. The hive-worker template already includes Chrome, Playwright MCP, and browser tools — so the verifier template is a thin variant, not a new build. The blueprint runner, step factory pattern, `execInWorkspace`, and `cleanupWorkspace` are all battle-tested from S03/S04. The Prisma schema already has `verifying` as a `TaskStatus` enum value and `templateType` on the `Workspace` model. The main novel work is: (1) the detection heuristic that picks a testing strategy, (2) the verifier blueprint steps that execute the strategy, and (3) the orchestration wiring that triggers verification after PR creation.

## Recommendation

Use the established blueprint step pattern for the verifier. The verifier blueprint is a separate step sequence (not part of the worker's 8-step pipeline) that runs in its own workspace. The orchestrator (task-queue worker) triggers it after the worker pipeline succeeds — transition task to `verifying`, create verifier workspace, run verifier blueprint, store report, transition to `done`.

For the detection strategy (R007), use a pragmatic heuristic chain based on repo contents:
1. If `package.json` has `test` script → run tests
2. If `package.json` has `dev` or `start` script → start the app, wait for port, browser-screenshot the landing page
3. If the repo has an `index.html` → serve it and screenshot
4. Fallback → report "no verification strategy found" (not a failure — just a gap)

This is sufficient for M001. The heuristic can be refined iteratively in later milestones.

## Implementation Landscape

### Key Files

- `templates/hive-verifier/main.tf` — New Coder template for verifier workspaces. Derived from `templates/hive-worker/main.tf` with: different variable set (needs `branch_name`, `repo_url`, `task_id` but not `task_prompt`), template type identification, same Chrome/Playwright/browser tools. Most of the worker template carries over directly.
- `templates/hive-verifier/Dockerfile` — Can symlink or copy `templates/hive-worker/Dockerfile` — identical base image with Chrome, Node.js, browser tools already included (R013 satisfied by the existing worker Dockerfile).
- `templates/hive-verifier/scripts/` — Copy from hive-worker. The verifier needs the same toolchain (gh, node, browser tools). May remove AI tools (pi/gsd) since the verifier doesn't run an agent.
- `src/lib/blueprint/verifier.ts` — Verifier blueprint definition. A function that returns the step sequence: `[cloneAndCheckout, detectStrategy, executeStrategy, generateReport]`. Uses the same `BlueprintStep`/`BlueprintContext` types from `types.ts`.
- `src/lib/blueprint/steps/verify-clone.ts` — Step: `gh repo clone <repoUrl> /home/coder/project && git checkout <branch>`. Straightforward exec step.
- `src/lib/blueprint/steps/verify-detect.ts` — Step: examine `package.json`, file structure in the workspace to determine verification strategy. Sets a `verificationStrategy` field on context.
- `src/lib/blueprint/steps/verify-execute.ts` — Step: runs the chosen strategy — `npm test`, or `npm run dev` + wait-for-port + `browser-screenshot`, or serve static HTML + screenshot.
- `src/lib/blueprint/steps/verify-report.ts` — Step: assembles a structured verification report from the execution results, stores it.
- `src/lib/verification/report.ts` — TypeScript types for the verification report (strategy used, pass/fail, output logs, screenshots taken). Stored as JSON in a new `VerificationReport` Prisma model or as a JSON column on `Task`.
- `src/lib/queue/task-queue.ts` — Modified: after worker blueprint succeeds and `prUrl` is set, create verifier workspace + run verifier blueprint before setting status to `done`. Cleanup verifier workspace in the same finally block pattern.
- `src/lib/api/tasks.ts` — Add `getVerificationReport(taskId)` function to retrieve the report.
- `src/lib/blueprint/types.ts` — Extend `BlueprintContext` with optional verifier-specific fields: `verificationStrategy`, `verificationReport`.

### Build Order

**T01: Verifier Coder Template** — Create `hive-verifier/` by deriving from `hive-worker/`. This is prerequisite for any verifier workspace creation. Proves the template can be pushed to Coder and a workspace can start. Low risk — it's mostly copying and trimming.

**T02: Verifier Blueprint Steps** — Build the 4 verifier steps (clone, detect, execute, report). This is the core novel work. The detection heuristic and strategy execution are the riskiest parts. Unit test each step with mocked `execInWorkspace`. Prove the detection heuristic covers the 3 main cases (test suite, web app, static site).

**T03: Orchestration & Persistence** — Wire the verifier into `task-queue.ts`. After worker blueprint succeeds, transition to `verifying`, create verifier workspace, run verifier blueprint, store report in DB, handle cleanup. Add verification report to the Prisma schema. Add API function. This integrates everything and proves the end-to-end flow with unit tests.

### Verification Approach

- Unit tests for each verifier step (clone, detect, execute, report) with mocked `execInWorkspace` — same pattern as S04 tests
- Unit test for detection heuristic covering: repo with `test` script, repo with `dev` script, repo with `index.html`, repo with none
- Unit test for the extended worker pipeline proving: successful worker → verifier triggers → report stored
- Unit test proving: worker failure → verifier does NOT trigger
- `npx vitest run` — full suite passes, zero regressions
- Prisma schema validates with `npx prisma validate`

## Constraints

- `BlueprintContext` is shared between worker and verifier — verifier-specific fields must be optional to avoid breaking the worker pipeline.
- The verifier workspace needs GitHub auth for `gh repo clone` — same `coder_external_auth.github` mechanism as worker.
- `execInWorkspace` timeout defaults to 60s — web app startup detection needs a longer timeout (e.g., 120s for `npm run dev` + port wait).
- The worker template Dockerfile already has Chrome and all browser tools — the verifier template should reuse the same Dockerfile to avoid maintaining two images.

## Common Pitfalls

- **Verifier workspace cleanup on failure** — If verifier blueprint fails mid-execution (e.g., `npm run dev` hangs), the workspace must still clean up. Use the same `finally` block + `cleanupWorkspace` pattern from the worker.
- **Port detection for web apps** — `npm run dev` may print the port to stdout or stderr. The verifier should use a configurable default (3000) and try to detect from output. Don't over-engineer — a simple `curl --retry` loop on port 3000 after starting the dev server is sufficient.
- **Browser screenshot in headless workspace** — The worker Dockerfile has Chrome and KasmVNC. But for headless verification, `browser-screenshot` CLI tool (already installed) is the right choice — it uses `google-chrome-stable --headless=new`. No display server needed.
- **Verification timeout** — Web apps that take >60s to start will time out. Use a 2-minute timeout for the dev server startup + a 30s timeout for the screenshot. Total verifier blueprint timeout should be ~10 minutes.

## Open Risks

- **Detection accuracy** — The heuristic may misclassify repos. A repo with both `test` and `dev` scripts should prioritize `test` (more deterministic). This is iterative — the heuristic improves with real usage data.
- **Flaky web app tests** — Starting a dev server and screenshotting is inherently flaky (port conflicts, slow builds, missing env vars). The verifier should treat screenshot failures as "inconclusive" rather than "failed" — the verification report should distinguish between "verified working", "verified broken", and "could not verify".
