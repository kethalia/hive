# S01: Council Infrastructure — UAT

**Milestone:** M002
**Written:** 2026-04-09T08:40:28.706Z

---
id: S01-UAT
parent: S01
milestone: M002
title: Council Infrastructure — User Acceptance Tests
created_at: 2026-04-09T08:37:21.000Z
---

# S01 UAT: Council Infrastructure

## Test Scope

This UAT verifies that all infrastructure components (Prisma schema, type definitions, queue infrastructure, Terraform template) are correctly implemented and integrated. These are **unit & integration tests**, not end-to-end tests. S02-S04 will add behavioral tests for the actual council review flow.

## Preconditions

- Node.js 20+ with npm installed
- Postgres database available (docker-compose can provision this)
- Redis available (docker-compose can provision this)
- Terraform CLI installed
- Working directory: `/home/coder/coder`

---

## Test Set 1: Prisma Schema & Types

### T1.1: Council columns exist in Task model

**Steps:**
1. Open `prisma/schema.prisma`
2. Search for the Task model
3. Verify two new columns exist:
   - `councilSize` with type `Int`, default `3`, map to `council_size`
   - `councilReport` with type `Json?`, map to `council_report`

**Expected Outcome:**
```prisma
model Task {
  // ... existing fields ...
  councilSize    Int   @default(3)      @map("council_size")
  councilReport  Json?                  @map("council_report")
  // ... other fields ...
}
```

**Pass Criteria:** Both columns visible with correct types and mappings.

---

### T1.2: Migration file is present and valid SQL

**Steps:**
1. List migration files: `ls -la prisma/migrations/ | grep council`
2. Read the migration: `cat prisma/migrations/20250409000000_add_council_columns/migration.sql`
3. Verify two ALTER TABLE statements

**Expected Outcome:**
```sql
ALTER TABLE "tasks" ADD COLUMN "council_size" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "tasks" ADD COLUMN "council_report" JSONB;
```

**Pass Criteria:** File exists, contains exactly two ALTER TABLE statements, no syntax errors.

---

### T1.3: Prisma client was regenerated

**Steps:**
1. Run: `npx prisma generate`
2. Verify exit code is 0
3. Check that no TypeScript errors are introduced by the schema change

**Expected Outcome:**
- Command exits cleanly (code 0)
- Node modules contain updated Prisma client
- TypeScript resolves the new fields on the Task type

**Pass Criteria:** Command succeeds, no new TS errors in `npx tsc --noEmit` (pre-existing errors are acceptable).

---

### T1.4: Council types are defined and exported

**Steps:**
1. Read `src/lib/council/types.ts`
2. Verify these interfaces exist:
   - `ReviewerFinding` with fields: file, startLine, severity, issue, fix, reasoning
   - `AggregatedFinding` extending ReviewerFinding with: agreementCount, isConsensus
   - `CouncilReport` with fields: outcome, councilSize, reviewersCompleted, findings, consensusItems, postedCommentUrl, durationMs, timestamp
3. Verify `isCouncilReport()` type guard function exists
4. Check all are exported (not private)

**Expected Outcome:**
```typescript
export interface ReviewerFinding { /* ... */ }
export interface AggregatedFinding extends ReviewerFinding { /* ... */ }
export interface CouncilReport { /* ... */ }
export function isCouncilReport(v: unknown): v is CouncilReport { /* ... */ }
```

**Pass Criteria:** All four types/functions exported with correct shape. Type guard validates at least: outcome string, councilSize number, findings array, consensusItems array, durationMs number.

---

## Test Set 2: Constants & Workspace Naming

### T2.1: Queue constants are defined

**Steps:**
1. Open `src/lib/constants.ts`
2. Search for COUNCIL_ constants
3. Verify these exist in the Queue section:
   - `COUNCIL_REVIEWER_QUEUE = "council-reviewer"`
   - `COUNCIL_AGGREGATOR_QUEUE = "council-aggregator"`
   - `COUNCIL_JOB_TIMEOUT_MS = 15 * 60 * 1_000` (15 minutes)

**Expected Outcome:**
```typescript
export const COUNCIL_REVIEWER_QUEUE = "council-reviewer";
export const COUNCIL_AGGREGATOR_QUEUE = "council-aggregator";
export const COUNCIL_JOB_TIMEOUT_MS = 15 * 60 * 1_000;
```

**Pass Criteria:** All three constants present with correct values.

---

### T2.2: Workspace naming helper is correct

**Steps:**
1. Open `src/lib/workspace/naming.ts`
2. Find `councilWorkspaceName(taskId, reviewerIndex)` function
3. Test it locally with example inputs:
   ```typescript
   councilWorkspaceName("abc123def456", 0)  // Should return "hive-council-abc123de-0"
   councilWorkspaceName("xyz789uvw012", 2)  // Should return "hive-council-xyz789uv-2"
   ```

**Expected Outcome:**
- Takes 8-char prefix of taskId
- Appends reviewerIndex directly (no offset)
- Format: `hive-council-{8-char-prefix}-{index}`

**Pass Criteria:** Function signature matches, naming convention follows pattern, exports correctly.

---

## Test Set 3: Queue Infrastructure

### T3.1: Council queue infrastructure exports are present

**Steps:**
1. Open `src/lib/queue/council-queues.ts`
2. Verify these are exported:
   - `CouncilReviewerJobData` interface with: taskId, reviewerIndex, prUrl, repoUrl, branchName
   - `CouncilAggregatorJobData` interface with: taskId, councilSize, prUrl
   - `getCouncilReviewerQueue()` function
   - `getCouncilAggregatorQueue()` function
   - `getCouncilFlowProducer()` function
   - `createCouncilReviewerWorker()` function
   - `createCouncilAggregatorWorker()` function

**Expected Outcome:**
All seven exports present with correct types and signatures.

**Pass Criteria:** All exports visible in the file and pass `npx tsc --noEmit` type checking.

---

### T3.2: Singletons are lazy-initialized

**Steps:**
1. Run unit tests: `npx vitest run src/__tests__/lib/queue/council-queues.test.ts`
2. Verify these test cases pass:
   - "getCouncilReviewerQueue() returns a Queue"
   - "getCouncilAggregatorQueue() returns a Queue"
   - "getCouncilFlowProducer() returns a FlowProducer"
   - "getCouncilReviewerQueue() is a singleton"
   - "getCouncilAggregatorQueue() is a singleton"
   - "getCouncilFlowProducer() is a singleton"

**Expected Outcome:**
All 6 tests pass. Singletons are identity-identical on repeated calls.

**Pass Criteria:** Test file runs without errors, all singleton tests pass.

---

### T3.3: Worker factories are correct

**Steps:**
1. Verify these test cases pass:
   - "createCouncilReviewerWorker() creates a Worker for council-reviewer queue"
   - "createCouncilAggregatorWorker() creates a Worker for council-aggregator queue"
2. Run: `npx vitest run src/__tests__/lib/queue/council-queues.test.ts`

**Expected Outcome:**
Both worker factory tests pass. Each factory returns a Worker configured for the correct queue.

**Pass Criteria:** Test cases pass, worker constructors called with correct queue names.

---

### T3.4: Worker skeletons log correctly

**Steps:**
1. Read `src/lib/queue/council-queues.ts`
2. Find the worker handler functions (the async callbacks passed to Worker constructors)
3. Verify each logs with the correct prefix:
   - Reviewer worker: `console.log("[council-reviewer] job received", job.id)`
   - Aggregator worker: `console.log("[council-aggregator] job received", job.id)`

**Expected Outcome:**
Both worker implementations log with their queue-specific prefix and include the job ID.

**Pass Criteria:** Logging statements match the expected format.

---

## Test Set 4: Terraform Template

### T4.1: Hive-council template directory structure

**Steps:**
1. List files: `ls -la templates/hive-council/`
2. Verify these files exist:
   - `main.tf`
   - `Dockerfile`
   - `scripts/init.sh`
   - `scripts/claude-install.sh`
   - `scripts/tools-shell.sh`, `tools-node.sh`, `tools-nvm.sh`, `tools-ci.sh`, `symlinks.sh` (5 total)
   - `.terraform.lock.hcl`

**Expected Outcome:**
All 11 files present.

**Pass Criteria:** Directory structure matches expectation.

---

### T4.2: Terraform validates without errors

**Steps:**
1. Run: `cd templates/hive-council && terraform init`
2. Verify exit code is 0
3. Run: `cd templates/hive-council && terraform validate`
4. Verify output contains "Success!"

**Expected Outcome:**
```
Success! The configuration is valid.
```

**Pass Criteria:** Both commands exit cleanly.

---

### T4.3: anthropic_api_key variable is declared correctly

**Steps:**
1. Open `templates/hive-council/main.tf`
2. Find the variable block for `anthropic_api_key`
3. Verify it has:
   - type = "string"
   - default = ""
   - sensitive = true

**Expected Outcome:**
```hcl
variable "anthropic_api_key" {
  description = "Anthropic API key for Claude Code CLI"
  type        = string
  default     = ""
  sensitive   = true
}
```

**Pass Criteria:** Variable block present with all required attributes.

---

### T4.4: ANTHROPIC_API_KEY is injected conditionally

**Steps:**
1. Open `templates/hive-council/main.tf`
2. Find the `coder_agent.env` block
3. Search for ANTHROPIC_API_KEY
4. Verify the merge pattern exists:
   ```hcl
   merge(
     {/* base env */},
     var.anthropic_api_key != "" ? { ANTHROPIC_API_KEY = var.anthropic_api_key } : {}
   )
   ```

**Expected Outcome:**
ANTHROPIC_API_KEY is only added to env when anthropic_api_key variable is non-empty.

**Pass Criteria:** Conditional merge pattern present and correct.

---

### T4.5: Browser tools are removed

**Steps:**
1. Open `templates/hive-council/main.tf`
2. Search for these strings (should NOT find):
   - `tools_browser`
   - `browser_serve`
   - `browser_vision`
   - `scripts/tools-browser.sh`
   - `scripts/browser-serve.sh`

**Expected Outcome:**
No matches found for any browser-related resources or scripts.

**Pass Criteria:** Zero occurrences of browser references.

---

### T4.6: Claude install script is present

**Steps:**
1. Read `templates/hive-council/scripts/claude-install.sh`
2. Verify it contains:
   - A curl command to install Claude CLI
   - Template variable reference for claude_api_key
   - Valid shell script structure

**Expected Outcome:**
Script is executable shell code that installs Claude CLI via curl.

**Pass Criteria:** Script exists and is properly formatted.

---

### T4.7: Workspace preset is named hive-council

**Steps:**
1. Open `templates/hive-council/main.tf`
2. Find `data "coder_workspace_preset"` block
3. Verify the name is "hive-council"
4. Verify instances = 1

**Expected Outcome:**
```hcl
data "coder_workspace_preset" "hive-council" {
  name = "hive-council"
  parameters = {
    // ...
  }
}
```

**Pass Criteria:** Preset named correctly with instances = 1.

---

## Test Set 5: Integration & Regression

### T5.1: All existing tests still pass

**Steps:**
1. Run: `npm test`
2. Verify all tests pass

**Expected Outcome:**
```
Test Files  26 passed (26)
Tests       161 passed (161)
```

**Pass Criteria:** 161 tests pass, zero failures, zero regressions.

---

### T5.2: TypeScript has no new errors

**Steps:**
1. Run: `npx tsc --noEmit`
2. Count the number of errors
3. Verify this is not higher than the baseline (23 pre-existing errors from ioredis/bullmq)

**Expected Outcome:**
Error count remains ≤ 23. No new TS2322 or other type errors introduced.

**Pass Criteria:** No net increase in TypeScript errors.

---

### T5.3: Council queue tests specifically pass

**Steps:**
1. Run: `npx vitest run src/__tests__/lib/queue/council-queues.test.ts`
2. Count passing tests

**Expected Outcome:**
```
Test Files  1 passed (1)
Tests       8 passed (8)
```

**Pass Criteria:** All 8 council queue tests pass.

---

## Edge Cases & Failure Modes

### E1: Prisma schema migration without live DB

**Scenario:** Database is not available when running migrations

**Expected Behavior:** Manual migration SQL is written; `npx prisma generate` regenerates the client without DB connection

**Validation:** Migration file exists and is syntactically correct SQL

**Pass Criteria:** Client regenerates successfully even without DB

---

### E2: Missing anthropic_api_key in environment

**Scenario:** Workspace is created without passing anthropic_api_key variable

**Expected Behavior:** ANTHROPIC_API_KEY env var is not set in the workspace (merge produces empty dict)

**Validation:** Template still validates; workspace creation succeeds but lacks the API key

**Pass Criteria:** Template validates regardless of whether API key is provided

---

### E3: Worker job handler errors

**Scenario:** A skeleton worker receives a malformed job

**Expected Behavior:** Worker logs job receipt before any handler logic, allowing job inspection in logs

**Validation:** Log message appears before any processing

**Pass Criteria:** Log output includes `[council-reviewer] job received` or `[council-aggregator] job received`

---

## Test Execution Checklist

- [x] T1.1: Prisma columns visible in schema
- [x] T1.2: Migration file is valid SQL
- [x] T1.3: Prisma client regenerated
- [x] T1.4: Council types exported
- [x] T2.1: Queue constants defined
- [x] T2.2: Workspace naming helper works
- [x] T3.1: Queue infrastructure exports present
- [x] T3.2: Singletons are lazy-initialized
- [x] T3.3: Worker factories are correct
- [x] T3.4: Worker skeletons log correctly
- [x] T4.1: Template directory structure complete
- [x] T4.2: Terraform validates
- [x] T4.3: anthropic_api_key variable declared
- [x] T4.4: ANTHROPIC_API_KEY injected conditionally
- [x] T4.5: Browser tools removed
- [x] T4.6: Claude install script present
- [x] T4.7: Workspace preset named hive-council
- [x] T5.1: All existing tests pass
- [x] T5.2: No new TypeScript errors
- [x] T5.3: Council queue tests pass

## Summary

All 20 test cases passed. Council infrastructure is foundation-ready for S02 integration.

