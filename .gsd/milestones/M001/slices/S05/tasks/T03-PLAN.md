---
estimated_steps: 4
estimated_files: 4
---

# T03: Wire verifier into orchestration pipeline with DB persistence

**Slice:** S05 — Verifier Template & Proof-by-Consumption
**Milestone:** M001

## Description

Integrate the verifier into the task-queue worker so that after the worker blueprint succeeds with a PR, a verifier workspace is created, the verifier blueprint runs, and the verification report is persisted. Also add `getVerificationReport()` to the API layer and update the Prisma schema with a `verificationReport` JSON column. This closes R006 by making verification automatic and R015 by reusing `cleanupWorkspace` for the verifier workspace.

## Steps

1. **Update Prisma schema** (`prisma/schema.prisma`). Add to the `Task` model:
   ```prisma
   verificationReport Json? @map("verification_report")
   ```
   Run `npx prisma validate` to confirm.

2. **Add `getVerificationReport()` to `src/lib/api/tasks.ts`.**
   ```typescript
   export async function getVerificationReport(taskId: string) {
     const db = getDb();
     const task = await db.task.findUnique({
       where: { id: taskId },
       select: { verificationReport: true },
     });
     return task?.verificationReport ?? null;
   }
   ```

3. **Extend the worker in `src/lib/queue/task-queue.ts`** to trigger the verifier after a successful worker blueprint:
   - Import `createVerifierBlueprint` from `@/lib/blueprint/verifier`
   - After the worker blueprint succeeds AND `ctx.prUrl` is truthy:
     - Update task status to `verifying`
     - Log `[queue] Starting verifier for task ${taskId}`
     - Create verifier workspace via `coderClient.createWorkspace(verifierTemplateId, verifierWorkspaceName, { task_id, repo_url, branch_name })` where `verifierTemplateId` comes from `process.env.CODER_VERIFIER_TEMPLATE_ID`
     - Record verifier workspace in DB with `templateType: "verifier"`
     - Wait for verifier workspace build
     - Get verifier agent name
     - Build verifier BlueprintContext (same repoUrl, branchName, taskId; empty assembledContext/scopedRules/toolFlags)
     - Run `runBlueprint(createVerifierBlueprint(), verifierCtx)`
     - Persist `verifierCtx.verificationReport` to `task.verificationReport`
     - If verifier blueprint fails: still set task to `done` (the PR exists — verification is informational). Store a report with outcome "inconclusive" and the failure message.
   - If worker blueprint fails (no prUrl): do NOT trigger verifier, set task to `failed` as before
   - Track verifier workspace ID and clean it up in the finally block alongside the worker workspace
   - The finally block should clean up BOTH workspace IDs if both exist

4. **Extend worker tests** (`src/__tests__/lib/queue/worker.test.ts`):
   - Mock `@/lib/blueprint/verifier` → `createVerifierBlueprint: vi.fn(() => [...])`
   - Test: successful worker → verifier triggers → task transitions through `verifying` → report persisted → task `done`
   - Test: worker failure (blueprint fails at agent step) → verifier NOT triggered → task `failed`
   - Test: verifier failure → task still set to `done` with verificationReport containing outcome "inconclusive"
   - Test: both worker and verifier workspaces cleaned up in finally block
   - Ensure `runBlueprint` mock can distinguish between worker and verifier calls (check the steps array length or step names)

## Must-Haves

- [ ] `verificationReport` JSON column on Task model validates with Prisma
- [ ] `getVerificationReport(taskId)` returns parsed report or null
- [ ] Worker triggers verifier only when `prUrl` is truthy (worker succeeded with PR)
- [ ] Task transitions: `running → verifying → done` on success path
- [ ] Worker failure does NOT trigger verifier
- [ ] Verifier failure does NOT block task completion — task still set to `done`
- [ ] Both worker and verifier workspaces cleaned up in finally block
- [ ] All existing worker tests still pass (no regressions)

## Verification

- `npx prisma validate` — schema validates
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — all tests pass including new verifier tests
- `npx vitest run` — full suite passes, zero regressions

## Observability Impact

- Signals added: `[queue] Starting verifier for task ${taskId}` log; task status transition `running → verifying → done`; `verificationReport` JSON persisted on task record
- How a future agent inspects this: query `tasks.verificationReport` for structured verification outcome; check `tasks.status = 'verifying'` to see tasks in verification phase; grep for `[queue] Starting verifier` in container logs
- Failure state exposed: verifier failure results in `verificationReport.outcome = "inconclusive"` with error message in logs field; verifier workspace cleanup logged with `[cleanup]` prefix

## Inputs

- `src/lib/blueprint/verifier.ts` — createVerifierBlueprint() factory (from T02)
- `src/lib/blueprint/types.ts` — BlueprintContext with verificationStrategy/verificationReport (from T01)
- `src/lib/verification/report.ts` — VerificationReport type (from T01)
- `src/lib/queue/task-queue.ts` — existing worker pipeline to extend
- `src/lib/workspace/cleanup.ts` — cleanupWorkspace function for verifier workspace cleanup
- `src/__tests__/lib/queue/worker.test.ts` — existing worker tests to extend
- S04 Forward Intelligence: worker pipeline is 8 steps; prUrl on task record is the verifier trigger signal; cleanupWorkspace is available for verifier; tasks.branch is populated after PR step

## Expected Output

- `prisma/schema.prisma` — Task model with `verificationReport Json?` column added
- `src/lib/api/tasks.ts` — `getVerificationReport()` function added
- `src/lib/queue/task-queue.ts` — worker extended with verifier trigger, verifier workspace lifecycle, report persistence
- `src/__tests__/lib/queue/worker.test.ts` — 3-4 new tests covering verifier integration
