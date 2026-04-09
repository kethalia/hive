# S01 Council Infrastructure — Research

**Slice:** Council Infrastructure  
**Risk:** High  
**Scope:** Prisma schema additions, BullMQ queue registration (FlowProducer pattern), `hive-council` Terraform template, workspace naming helper, verifier made awaitable (step 9), constants additions.

---

## Summary

S01 is infrastructure groundwork — no novel algorithms, but several distinct additions that must all land before S02/S03 can build on them. The codebase patterns are extremely consistent and well-established. Every change follows an existing pattern exactly; the main risks are (a) the FlowProducer integration being new to this project and (b) the verifier becoming awaitable changing pipeline timing. Both are low-surprise once the mechanics are understood.

---

## Recommendation

Build in this order (dependency order, smallest blast radius first):

1. **Prisma schema** — add `councilSize` + `councilReport` columns; generate + apply migration
2. **Workspace naming** — add `councilWorkspaceName()` to `naming.ts`
3. **Constants** — add council queue names, timeout, and template env var name
4. **hive-council Terraform template** — copy hive-verifier structure, replace Pi with Claude CLI, add `anthropic_api_key` variable, remove browser tools
5. **BullMQ queue infrastructure** — add `council-reviewer` + `council-aggregator` queues + worker skeletons; add FlowProducer factory
6. **Make verifier awaitable** — promote from fire-and-forget in `task-queue.ts` to proper `await` (already in a try/catch block — straightforward)
7. **Unit tests** — queue registration smoke tests; schema column verification

---

## Implementation Landscape

### 1. Prisma Schema (`prisma/schema.prisma`)

Current `Task` model lacks `councilSize` and `councilReport`. Two fields to add:

```prisma
councilSize    Int   @default(3)      @map("council_size")
councilReport  Json?                  @map("council_report")
```

Pattern: `verificationReport Json? @map("verification_report")` is already there — identical pattern.  
Migration: `npx prisma migrate dev --name add_council_columns`

### 2. Workspace Naming (`src/lib/workspace/naming.ts`)

File currently exports `workerWorkspaceName` and `verifierWorkspaceName`. Add:

```typescript
export function councilWorkspaceName(taskId: string, reviewerIndex: number): string {
  return `hive-council-${taskId.slice(0, 8)}-${reviewerIndex}`;
}
```

No surprises — same pattern, same file.

### 3. Constants (`src/lib/constants.ts`)

Add at the bottom of the Queue section:

```typescript
export const COUNCIL_REVIEWER_QUEUE = "council-reviewer";
export const COUNCIL_AGGREGATOR_QUEUE = "council-aggregator";
export const COUNCIL_JOB_TIMEOUT_MS = 15 * 60 * 1_000; // 15 min per reviewer
```

### 4. hive-council Terraform Template (`templates/hive-council/`)

**Key insight:** ai-dev template already has the exact `claude-install.sh` pattern and the `ANTHROPIC_API_KEY` injection via:
```hcl
var.claude_code_api_key != "" ? { ANTHROPIC_API_KEY = var.claude_code_api_key } : {}
```

For hive-council the variable name in the context is `anthropic_api_key` (not `claude_code_api_key`) per D011. Pattern to follow is `ai-dev/main.tf` + `ai-dev/scripts/claude-install.sh`.

**Files needed:**
- `templates/hive-council/main.tf` — based on hive-verifier structure but:
  - Variables: `task_id`, `repo_url`, `branch_name`, `anthropic_api_key` (sensitive), `docker_socket`, `dotfiles_uri`
  - Agent env: `ANTHROPIC_API_KEY = var.anthropic_api_key`, `HIVE_TASK_ID`, `HIVE_REPO_URL`, `HIVE_BRANCH_NAME`
  - Remove: `task_prompt` variable (reviewers don't need it)
  - Remove: browser tools, browser-serve, browser-vision app (council is read-only)
  - Keep: GitHub external auth, git-config module, git-commit-signing, github-upload-public-key, Node.js tools, CI tools
  - `coder_workspace_preset` named `hive-council` with `instances = 1`
- `templates/hive-council/Dockerfile` — copy from hive-verifier (same base image needed; no Playwright)
  - Actually, hive-verifier has Chrome/Playwright — check if we need a leaner Dockerfile. For council (read-only review, just needs `gh`, `git`, `claude`) the verifier Dockerfile is overkill but re-using it is safe and avoids a new build.
- `templates/hive-council/scripts/` — copy from hive-verifier, remove `tools-browser.sh` and `browser-serve.sh`; add `claude-install.sh` (copy from ai-dev); update `init.sh` to not reference browser scripts
- `templates/hive-council/.terraform.lock.hcl` — cannot be created until `terraform init` runs inside the template dir (same providers as hive-verifier so the lockfile can be copied)

**`terraform validate` constraint:** The milestone context says this must pass. Running `terraform validate` requires `terraform init` first, which downloads providers. The hive-verifier `.terraform` directory with providers is already present — we can copy it.

### 5. BullMQ Queue Infrastructure (`src/lib/queue/`)

**Current state:** Single `Queue` + single `Worker` for `task-dispatch`. No `FlowProducer` anywhere in the codebase. BullMQ 5.71.0 is installed — `FlowProducer` is exported.

**What to add:** Two new files:
- `src/lib/queue/council-queues.ts` — exports:
  - `getCouncilReviewerQueue()` — lazy singleton `Queue<CouncilReviewerJobData>`
  - `getCouncilAggregatorQueue()` — lazy singleton `Queue<CouncilAggregatorJobData>`
  - `getCouncilFlowProducer()` — lazy singleton `FlowProducer` using `getRedisConnection()`
  - `createCouncilReviewerWorker(coderClient)` — `Worker` for `council-reviewer` queue (skeleton for S02)
  - `createCouncilAggregatorWorker()` — `Worker` for `council-aggregator` queue (skeleton for S03)

**FlowProducer pattern:**
```typescript
import { FlowProducer } from "bullmq";
let flowProducer: FlowProducer | null = null;
export function getCouncilFlowProducer(): FlowProducer {
  if (!flowProducer) {
    flowProducer = new FlowProducer({ connection: getRedisConnection() });
  }
  return flowProducer;
}
```

**Job data shapes:**
```typescript
export interface CouncilReviewerJobData {
  taskId: string;
  reviewerIndex: number;
  prUrl: string;
  repoUrl: string;
  branchName: string;
}

export interface CouncilAggregatorJobData {
  taskId: string;
  councilSize: number;
  prUrl: string;
}
```

**Worker skeleton pattern:** Both workers follow the exact same constructor shape as `createTaskWorker` — `new Worker(QUEUE_NAME, processor, { connection, concurrency, lockDuration })`. S01 worker bodies can be minimal stubs (log + return) since S02/S03 implement the logic. The S01 requirement is that workers *register and accept test jobs*.

**Important:** `continueParentOnFailure: true` is set on child jobs at FlowProducer.add() time (as job options), not on the queue. This is handled in S02's `createCouncilStep`, not in the queue infrastructure.

### 6. Making Verifier Awaitable (`src/lib/queue/task-queue.ts`)

**Current state:** Verifier already runs in a `try/catch` block inside the main worker. It's effectively "awaitable" — the code `await runBlueprint(verifierSteps, verifierCtx)` is already there. It's awaited, not fire-and-forget.

**Key re-read:** Looking at the code more carefully, the verifier *is* already awaited — the issue is that `task.status` transitions. Currently:
- Worker sets `status: "verifying"` when prUrl exists (before verifier runs)
- After verifier, sets `status: "done"`

For council (step 10) to run *after* verifier:
- The council step runs after the verifier `try/catch` block inside the worker processor
- The current code already finishes the verifier before moving on — the `await` is there
- What needs to change: council must be triggered *inside* the same processor, after the verifier block concludes, before setting final `status: "done"`

**Concretely:** The verifier section currently ends by calling `db.task.update({ status: "done" })`. For council to be step 10, we need to:
1. Remove the `status: "done"` update from inside the verifier block (defer it)
2. After verifier block, run council
3. Set `status: "done"` after council

S01 doesn't implement council logic — it just adds the queue infrastructure. The actual task-queue wiring (step 10) happens in S02 when `createCouncilStep` is built. S01 just needs the *queues and workers to exist*.

**Revised scope for S01:** Making the verifier "awaitable as step 9" means verifying the current code already awaits it (✓ confirmed) and documenting the wiring pattern for S02. No code change needed in task-queue.ts for S01 — the wiring of step 10 is deferred to S02.

### 7. Type Definitions (`src/lib/council/types.ts` — new file)

The `ReviewerFinding`, `AggregatedFinding`, and `CouncilReport` interfaces should live in a central types file that all slices import. Create `src/lib/council/types.ts` based on the interface contracts in the milestone context. This is pure TypeScript, no logic.

### 8. Unit Tests

**Queue registration tests** (`src/__tests__/lib/queue/council-queues.test.ts`):
- Mock pattern: same as `worker.test.ts` — mock `ioredis`, mock `bullmq`, mock `@/lib/queue/connection`
- Test: `getCouncilReviewerQueue()` returns a Queue with the right name
- Test: `getCouncilAggregatorQueue()` returns a Queue with the right name  
- Test: `getCouncilFlowProducer()` returns a FlowProducer
- Test: Workers constructed with correct queue names + lock duration

**Schema test** — Prisma migration is verified by `prisma migrate deploy` succeeding + querying `councilSize` from a task record. This is more of an integration check — typically verified by running the migration against the dev DB.

---

## Key Files

| File | Action | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | Edit | Add `councilSize Int @default(3)`, `councilReport Json?` to Task |
| `src/lib/workspace/naming.ts` | Edit | Add `councilWorkspaceName(taskId, idx)` |
| `src/lib/constants.ts` | Edit | Add queue name constants + COUNCIL_JOB_TIMEOUT_MS |
| `src/lib/council/types.ts` | Create | ReviewerFinding, AggregatedFinding, CouncilReport interfaces |
| `src/lib/queue/council-queues.ts` | Create | Queue singletons + FlowProducer + Worker skeletons |
| `templates/hive-council/main.tf` | Create | Based on hive-verifier, Claude CLI, anthropic_api_key var |
| `templates/hive-council/Dockerfile` | Create | Copy from hive-verifier (or leaner) |
| `templates/hive-council/scripts/init.sh` | Create | Copy from hive-verifier, remove browser refs |
| `templates/hive-council/scripts/tools-*.sh` | Create | Copy relevant scripts from hive-verifier, add claude-install.sh |
| `templates/hive-council/.terraform.lock.hcl` | Create | Copy from hive-verifier (same providers) |
| `src/__tests__/lib/queue/council-queues.test.ts` | Create | Queue registration unit tests |

---

## Constraints & Gotchas

1. **FlowProducer `connection` option:** BullMQ 5.x requires `{ connection: IORedis }` on FlowProducer constructor — same as Queue/Worker. The existing `getRedisConnection()` singleton is reusable as-is (confirmed: `maxRetriesPerRequest: null` is required and already set).

2. **`terraform validate` requires `terraform init` first.** The `.terraform` directory with providers must be present. Safest approach: copy the `.terraform` provider cache from `templates/hive-verifier/.terraform/providers/` into `templates/hive-council/.terraform/providers/` and copy `.terraform.lock.hcl`. Both templates use identical providers (`coder/coder ~> 2.15`, `kreuzwerker/docker ~> 3.6`).

3. **`anthropic_api_key` variable naming:** The milestone context uses `anthropic_api_key` (not `claude_code_api_key` as in ai-dev). This is intentional — the council template is purpose-built. The env injection pattern from ai-dev is:
   ```hcl
   ANTHROPIC_API_KEY = var.anthropic_api_key != "" ? var.anthropic_api_key : ""
   ```
   Or use the merge pattern from ai-dev: `merge({ ... }, var.anthropic_api_key != "" ? { ANTHROPIC_API_KEY = var.anthropic_api_key } : {})`.

4. **Worker skeleton bodies:** S01 workers don't need real logic — just enough to register and accept a job without throwing. Pattern: `async (job) => { console.log('[council-reviewer] job received', job.id); return {}; }`. S02 replaces these with real implementations.

5. **`councilSize` default=3 in Prisma schema** — task submission form (S04) will let users override this. The `createTask` API call in `src/lib/api/tasks.ts` currently doesn't accept `councilSize` — S04 adds that. S01 just needs the DB column to exist.

6. **Task status during council:** The existing pipeline sets `status: "done"` after verifier. Council (step 10) runs before that final `"done"` set. But this wiring is in S02 — S01 doesn't touch task-queue.ts logic.

7. **hive-council Dockerfile:** The verifier Dockerfile includes Playwright/Chrome which council doesn't need. Options: (a) reuse verifier Dockerfile as-is (wastes 500MB image size, simpler), (b) create leaner Dockerfile (just node + claude + gh). Given S01's goal is `terraform validate` passing — the Dockerfile content doesn't affect validation, so reusing the verifier Dockerfile is fine for S01. Image size optimization is out of scope.

---

## Verification Commands

```bash
# 1. Prisma migration
npx prisma migrate dev --name add_council_columns
npx prisma db push  # verify schema applied

# 2. TypeScript — no errors introduced
npx tsc --noEmit

# 3. Unit tests
npx vitest run src/__tests__/lib/queue/council-queues.test.ts

# 4. Terraform validate
cd templates/hive-council && terraform init && terraform validate

# 5. Existing tests still pass
npx vitest run
```
