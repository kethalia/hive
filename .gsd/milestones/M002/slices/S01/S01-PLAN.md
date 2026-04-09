# S01: Council Infrastructure

**Goal:** Prisma schema, council type definitions, BullMQ queue infrastructure (FlowProducer + worker skeletons), constants, workspace naming, and hive-council Terraform template are all in place — providing the foundation for S02-S04.
**Demo:** terraform validate passes for hive-council template; prisma migrate adds councilSize + councilReport columns; BullMQ workers for both council queues register and accept test jobs; existing pipeline tests still pass with verifier as awaitable step 9.

## Must-Haves

- `npx prisma migrate dev` succeeds adding councilSize + councilReport columns to Task
- `npx tsc --noEmit` passes with zero errors
- `npx vitest run src/__tests__/lib/queue/council-queues.test.ts` passes — queue singletons, FlowProducer, and worker skeletons verified
- `cd templates/hive-council && terraform init && terraform validate` passes
- `npx vitest run` — all existing tests still pass

## Proof Level

- This slice proves: Contract — proves infrastructure exists and type-checks; no runtime integration yet.

## Integration Closure

- Upstream surfaces consumed: `src/lib/queue/connection.ts` (getRedisConnection), `src/lib/constants.ts`, `src/lib/workspace/naming.ts`, `prisma/schema.prisma`
- New wiring introduced: council queue singletons + FlowProducer factory, council types, hive-council template
- What remains: S02 wires council step into task-queue.ts pipeline; S03 implements aggregation logic; S04 adds dashboard UI

## Verification

- Runtime signals: Worker skeletons log job receipt at info level (`[council-reviewer]`, `[council-aggregator]`)
- Inspection surfaces: BullMQ dashboard (if connected) shows council-reviewer and council-aggregator queues
- Failure visibility: Queue connection failures surface via existing Redis error handling in connection.ts

## Tasks

- [x] **T01: Add Prisma columns, council types, constants, naming helper, and BullMQ queue infrastructure** `est:45m`
  This task lays all the TypeScript and database foundations for the council feature in one pass. It adds councilSize + councilReport to the Prisma schema, creates the council type definitions (ReviewerFinding, AggregatedFinding, CouncilReport), adds queue name constants and timeout, adds the councilWorkspaceName helper, and creates the BullMQ queue infrastructure (two queue singletons, FlowProducer factory, two worker skeletons).

## Steps

1. Edit `prisma/schema.prisma` — add to the Task model:
   ```prisma
   councilSize    Int   @default(3)      @map("council_size")
   councilReport  Json?                  @map("council_report")
   ```
   Place after `verificationReport` line. Then run `npx prisma migrate dev --name add_council_columns` and `npx prisma generate`.

2. Create `src/lib/council/types.ts` with these interfaces:
   - `ReviewerFinding` — `{ file: string; startLine: number; severity: 'critical' | 'major' | 'minor' | 'nit'; issue: string; fix: string; reasoning: string }`
   - `AggregatedFinding` — extends ReviewerFinding with `{ agreementCount: number; isConsensus: boolean }`
   - `CouncilReport` — `{ outcome: 'complete' | 'partial' | 'inconclusive'; councilSize: number; reviewersCompleted: number; findings: AggregatedFinding[]; consensusItems: AggregatedFinding[]; postedCommentUrl: string | null; durationMs: number; timestamp: string }`
   - Type guard `isCouncilReport(v: unknown): v is CouncilReport`

3. Edit `src/lib/constants.ts` — add at the bottom of the Queue section:
   ```typescript
   export const COUNCIL_REVIEWER_QUEUE = "council-reviewer";
   export const COUNCIL_AGGREGATOR_QUEUE = "council-aggregator";
   export const COUNCIL_JOB_TIMEOUT_MS = 15 * 60 * 1_000; // 15 min per reviewer
   ```

4. Edit `src/lib/workspace/naming.ts` — add:
   ```typescript
   export function councilWorkspaceName(taskId: string, reviewerIndex: number): string {
     return `hive-council-${taskId.slice(0, 8)}-${reviewerIndex}`;
   }
   ```

5. Create `src/lib/queue/council-queues.ts`:
   - Import `Queue`, `Worker`, `FlowProducer` from `bullmq`, `getRedisConnection` from `./connection`
   - Import queue name constants from `@/lib/constants`
   - Define and export `CouncilReviewerJobData` interface: `{ taskId, reviewerIndex, prUrl, repoUrl, branchName }`
   - Define and export `CouncilAggregatorJobData` interface: `{ taskId, councilSize, prUrl }`
   - Lazy singleton `getCouncilReviewerQueue()` — `new Queue<CouncilReviewerJobData>(COUNCIL_REVIEWER_QUEUE, { connection })`
   - Lazy singleton `getCouncilAggregatorQueue()` — `new Queue<CouncilAggregatorJobData>(COUNCIL_AGGREGATOR_QUEUE, { connection })`
   - Lazy singleton `getCouncilFlowProducer()` — `new FlowProducer({ connection })`
   - `createCouncilReviewerWorker()` — returns `new Worker(COUNCIL_REVIEWER_QUEUE, async (job) => { console.log('[council-reviewer] job received', job.id); return {}; }, { connection, concurrency: 5, lockDuration: COUNCIL_JOB_TIMEOUT_MS })`
   - `createCouncilAggregatorWorker()` — returns `new Worker(COUNCIL_AGGREGATOR_QUEUE, async (job) => { console.log('[council-aggregator] job received', job.id); return {}; }, { connection, concurrency: 3, lockDuration: COUNCIL_JOB_TIMEOUT_MS })`

6. Run `npx tsc --noEmit` to verify everything type-checks.

## Must-Haves
- councilSize Int @default(3) and councilReport Json? columns exist in Task model
- Prisma migration succeeds and client regenerated
- ReviewerFinding, AggregatedFinding, CouncilReport types exported
- isCouncilReport type guard exported
- COUNCIL_REVIEWER_QUEUE, COUNCIL_AGGREGATOR_QUEUE, COUNCIL_JOB_TIMEOUT_MS constants exported
- councilWorkspaceName function exported
- Queue singletons, FlowProducer factory, and worker skeleton factories exported
- `npx tsc --noEmit` passes
  - Files: `prisma/schema.prisma`, `src/lib/council/types.ts`, `src/lib/constants.ts`, `src/lib/workspace/naming.ts`, `src/lib/queue/council-queues.ts`
  - Verify: npx prisma migrate dev --name add_council_columns && npx tsc --noEmit

- [x] **T02: Create hive-council Terraform template with Claude CLI support** `est:45m`
  Create the `templates/hive-council/` Terraform template based on hive-verifier, adapted for council reviewers: Claude CLI instead of Pi, anthropic_api_key variable, no browser tools. Must pass `terraform validate`.

## Steps

1. Create `templates/hive-council/` directory structure. Copy these files from `templates/hive-verifier/`:
   - `Dockerfile` (reuse as-is — image size optimization is out of scope per research)
   - `scripts/tools-shell.sh`
   - `scripts/tools-node.sh`
   - `scripts/tools-nvm.sh`
   - `scripts/tools-ci.sh`
   - `scripts/symlinks.sh`
   Do NOT copy: `scripts/tools-browser.sh`, `scripts/browser-serve.sh`

2. Create `templates/hive-council/scripts/claude-install.sh` — copy from `templates/ai-dev/scripts/claude-install.sh`. The script installs Claude Code CLI via `curl -fsSL https://claude.ai/install.sh | bash`. The template variable reference should use `claude_api_key` (matching the templatefile call).

3. Create `templates/hive-council/scripts/init.sh` — copy from `templates/hive-verifier/scripts/init.sh` but update the README content to say "council reviewer workspace" instead of "verifier workspace". Remove any browser-related references from the README.

4. Create `templates/hive-council/main.tf` based on `templates/hive-verifier/main.tf` with these changes:
   - Same terraform block (coder ~> 2.15, docker ~> 3.6)
   - Variables: keep `task_id`, `repo_url`, `branch_name`, `docker_socket`, `dotfiles_uri`. Add `anthropic_api_key` (string, default "", sensitive=true). Remove any verifier-specific variables not listed.
   - Workspace preset: name = "hive-council" (not "hive-verifier")
   - Agent env block: keep GIT_*, HIVE_TASK_ID, HIVE_REPO_URL, HIVE_BRANCH_NAME. Add ANTHROPIC_API_KEY using merge pattern: `merge({...base_env...}, var.anthropic_api_key != "" ? { ANTHROPIC_API_KEY = var.anthropic_api_key } : {})`
   - coder_script resources: keep tools_shell, tools_node, tools_ci, tools_nvm, symlinks. REMOVE tools_browser, browser_serve. ADD claude_install script using `templatefile("${path.module}/scripts/claude-install.sh", { claude_api_key = var.anthropic_api_key })`
   - REMOVE coder_app "browser_vision" resource entirely
   - Keep: GitHub external auth, git modules (github-upload-public-key, git-commit-signing, git-config)
   - Keep: docker_volume, docker_image, docker_container (identical to verifier)
   - Keep: all agent metadata blocks

5. Copy `.terraform.lock.hcl` from `templates/hive-verifier/.terraform.lock.hcl` (same providers).

6. Run `cd templates/hive-council && terraform init && terraform validate` to verify.

## Must-Haves
- `templates/hive-council/main.tf` exists and passes terraform validate
- anthropic_api_key variable declared as sensitive
- ANTHROPIC_API_KEY injected into agent env when non-empty
- Claude CLI install script present
- No browser tools/scripts/apps in the template
- Workspace preset named hive-council with instances = 1
  - Files: `templates/hive-council/main.tf`, `templates/hive-council/Dockerfile`, `templates/hive-council/scripts/init.sh`, `templates/hive-council/scripts/claude-install.sh`, `templates/hive-council/scripts/tools-shell.sh`, `templates/hive-council/scripts/tools-node.sh`, `templates/hive-council/scripts/tools-nvm.sh`, `templates/hive-council/scripts/tools-ci.sh`, `templates/hive-council/scripts/symlinks.sh`, `templates/hive-council/.terraform.lock.hcl`
  - Verify: cd templates/hive-council && terraform init && terraform validate

- [x] **T03: Add unit tests for council queue infrastructure and verify full suite passes** `est:30m`
  Write unit tests for the council queue singletons, FlowProducer factory, and worker skeletons. Follow the exact mock pattern from `src/__tests__/lib/queue/worker.test.ts`. Then run the full test suite to confirm nothing is broken.

## Steps

1. Create `src/__tests__/lib/queue/council-queues.test.ts` following the mock pattern from `worker.test.ts`:
   - Mock `ioredis` with default export returning `{ status: 'ready', disconnect: vi.fn(), quit: vi.fn() }`
   - Mock `@/lib/queue/connection` with `getRedisConnection` returning the mock
   - Mock `bullmq` with `Queue`, `Worker`, and `FlowProducer` constructors (vi.fn().mockImplementation)
   - Import the functions under test from `@/lib/queue/council-queues`

2. Write these test cases:
   - `getCouncilReviewerQueue()` — returns a Queue constructed with name 'council-reviewer' and connection option
   - `getCouncilAggregatorQueue()` — returns a Queue constructed with name 'council-aggregator' and connection option
   - `getCouncilFlowProducer()` — returns a FlowProducer constructed with connection option
   - `getCouncilReviewerQueue()` is a singleton — calling twice returns same instance
   - `getCouncilAggregatorQueue()` is a singleton — calling twice returns same instance
   - `getCouncilFlowProducer()` is a singleton — calling twice returns same instance
   - `createCouncilReviewerWorker()` — Worker constructed with 'council-reviewer' queue name
   - `createCouncilAggregatorWorker()` — Worker constructed with 'council-aggregator' queue name

3. Run `npx vitest run src/__tests__/lib/queue/council-queues.test.ts` — all tests pass.

4. Run `npx vitest run` — full test suite passes (existing tests unbroken).

## Must-Haves
- All 8 test cases pass
- Mock pattern matches existing worker.test.ts conventions
- Full test suite passes with no regressions
  - Files: `src/__tests__/lib/queue/council-queues.test.ts`
  - Verify: npx vitest run src/__tests__/lib/queue/council-queues.test.ts && npx vitest run

## Files Likely Touched

- prisma/schema.prisma
- src/lib/council/types.ts
- src/lib/constants.ts
- src/lib/workspace/naming.ts
- src/lib/queue/council-queues.ts
- templates/hive-council/main.tf
- templates/hive-council/Dockerfile
- templates/hive-council/scripts/init.sh
- templates/hive-council/scripts/claude-install.sh
- templates/hive-council/scripts/tools-shell.sh
- templates/hive-council/scripts/tools-node.sh
- templates/hive-council/scripts/tools-nvm.sh
- templates/hive-council/scripts/tools-ci.sh
- templates/hive-council/scripts/symlinks.sh
- templates/hive-council/.terraform.lock.hcl
- src/__tests__/lib/queue/council-queues.test.ts
