---
id: S01
parent: M002
milestone: M002
provides:
  - Prisma schema extended with councilSize + councilReport columns
  - Council type definitions (ReviewerFinding, AggregatedFinding, CouncilReport) with type guard
  - Queue constants and workspace naming helper
  - BullMQ queue singletons + worker factories
  - hive-council Terraform template with Claude CLI support
  - Complete unit test coverage for queue infrastructure
requires:
  []
affects:
  - S02 (Review Blueprint & Claude Integration) — depends on council queue infrastructure
  - S03 (Aggregation & PR Comment) — depends on council types and queue data
  - S04 (Council Dashboard) — depends on councilSize column and CouncilReport type
key_files:
  - prisma/schema.prisma
  - prisma/migrations/20250409000000_add_council_columns/migration.sql
  - src/lib/council/types.ts
  - src/lib/constants.ts
  - src/lib/workspace/naming.ts
  - src/lib/queue/council-queues.ts
  - templates/hive-council/main.tf
  - src/__tests__/lib/queue/council-queues.test.ts
key_decisions:
  - Manual Prisma migration due to --create-only requiring live DB
  - Conditional Terraform env injection pattern
  - Worker skeleton logging with queue-specific prefixes
  - Singleton identity vs call-count testing pattern
patterns_established:
  - Lazy singleton pattern for BullMQ queues (matches task-queue.ts)
  - Type guard pattern for JSON? columns in Prisma (matches isVerificationReport)
  - Conditional Terraform variable injection pattern for optional env vars
  - Worker skeleton logging convention with [queue-name] prefix
observability_surfaces:
  - none
drill_down_paths:
  - .gsd/milestones/M002/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S01/tasks/T02-SUMMARY.md
  - .gsd/milestones/M002/slices/S01/tasks/T03-SUMMARY.md
duration: ""
verification_result: passed
completed_at: 2026-04-09T08:40:28.706Z
blocker_discovered: false
---

# S01: Council Infrastructure

**Delivered complete council infrastructure: Prisma schema with councilSize + councilReport columns, type definitions (ReviewerFinding, AggregatedFinding, CouncilReport with type guard), BullMQ queue singletons + worker factories with skeleton implementations, hive-council Terraform template with Claude CLI support, and 8 unit tests — all 161 tests pass with zero regressions.**

## What Happened

S01 delivered the foundation for the multi-agent council review feature across three focused tasks.

**T01: Database & Queue Infrastructure** established the core data model and job queue infrastructure. The Prisma schema was extended with councilSize (Int @default(3)) and councilReport (Json?) columns to store council metadata on each Task. A complete council type system was created (ReviewerFinding, AggregatedFinding, CouncilReport) with proper JSDoc and a runtime type guard for safe JSON deserialization. Queue constants were added (COUNCIL_REVIEWER_QUEUE, COUNCIL_AGGREGATOR_QUEUE, COUNCIL_JOB_TIMEOUT_MS). The councilWorkspaceName helper was added to the workspace naming convention, centralizing derivation logic. Finally, src/lib/queue/council-queues.ts provides the complete queue infrastructure: two lazy Queue singletons (reviewer, aggregator), a FlowProducer singleton for atomic fan-out/fan-in, and two worker factories (reviewer with concurrency 5, aggregator with concurrency 3) with skeleton implementations logging job receipt at info level. The pattern mirrors existing task-queue.ts for consistency.

**T02: Terraform Template** created the hive-council workspace template for running reviewer agents inside Coder. The template was adapted from hive-verifier by copying 9 base files (Dockerfile, tools scripts, .terraform.lock.hcl) and creating two new files: claude-install.sh (from templates/ai-dev) and an updated init.sh removing browser references. The main.tf file was refactored with the critical additions: anthropic_api_key variable (sensitive=true) with conditional env injection using Terraform's merge pattern, claude_install coder_script, and complete removal of browser tools/scripts/apps (tools_browser, browser_serve, browser_vision). The workspace preset was renamed to hive-council with instances=1. terraform validate confirmed the template is syntactically correct.

**T03: Unit Tests** added 8 comprehensive tests covering queue infrastructure. Following the pattern from worker.test.ts, tests mock ioredis, the connection module, and BullMQ classes. Test cases verify all three singletons (reviewer queue, aggregator queue, FlowProducer) construct correctly and maintain identity on repeated calls. Tests also verify both worker factories construct workers with the correct queue names. All tests pass; the full suite (161 tests across 26 files) runs with zero regressions.

**Verification Evidence:**
- Prisma schema updated with council columns (councilSize Int @default(3), councilReport Json?)
- Migration file written manually (prisma migrate dev unavailable without DB) and prisma generate succeeded
- All council types exported with correct interfaces and type guard
- Queue constants defined and exported
- councilWorkspaceName helper function added to naming.ts
- council-queues.ts exports all required singletons and worker factories
- 8 unit tests pass for queue infrastructure
- terraform validate passes without errors for hive-council template
- anthropic_api_key variable declared with sensitive=true and conditional injection pattern
- No browser references remain in Terraform template
- Full test suite passes: 161/161 tests, 26 test files, zero regressions
- TypeScript check shows 23 errors (pre-existing ioredis/bullmq dual-install, 0 net new errors)

**Key Decisions:**
1. Prisma migration written manually because --create-only still requires DB connection (P1001); pattern documented in KNOWLEDGE.md
2. Conditional Terraform env injection using merge() to avoid exposing empty API key string
3. Worker skeleton logging with queue-specific prefixes for immediate observability
4. Singleton tests use identity assertions rather than call-count guards due to module state persistence

**Patterns Established:**
- Lazy singleton pattern for BullMQ queues (matches task-queue.ts)
- Type guard pattern for JSON? columns in Prisma (matches isVerificationReport)
- Conditional Terraform variable injection pattern (reusable for any optional env vars)
- Worker skeleton logging convention with [queue-name] prefix

**Integration Closure:**
Upstream surfaces consumed: getRedisConnection from connection.ts, existing constants.ts structure, workspace naming convention pattern, Task model in schema.prisma. New surfaces created: council types, queue infrastructure, Terraform template. What remains: S02 wires council step into task-queue pipeline; S03 implements aggregation logic; S04 adds dashboard UI.

## Verification


### Verification Summary

All slice-level checks passed:
- ✅ Prisma schema: councilSize + councilReport columns present
- ✅ Prisma migration: migration.sql file valid
- ✅ Prisma client: regenerated successfully
- ✅ Type definitions: ReviewerFinding, AggregatedFinding, CouncilReport, isCouncilReport exported
- ✅ Constants: COUNCIL_REVIEWER_QUEUE, COUNCIL_AGGREGATOR_QUEUE, COUNCIL_JOB_TIMEOUT_MS defined
- ✅ Workspace naming: councilWorkspaceName function exported
- ✅ Queue infrastructure: 3 singletons + 2 worker factories exported
- ✅ Worker logging: [council-reviewer] and [council-aggregator] prefixes present
- ✅ Unit tests: 8/8 council queue tests pass
- ✅ Terraform: template passes terraform init and terraform validate
- ✅ Template variables: anthropic_api_key declared with sensitive=true
- ✅ Env injection: conditional merge pattern for ANTHROPIC_API_KEY present
- ✅ Browser removal: zero browser references in template
- ✅ Workspace preset: named hive-council with instances=1
- ✅ Full test suite: 161/161 tests pass, zero regressions
- ✅ TypeScript: 23 pre-existing errors (0 net new)

All must-haves from S01-PLAN.md verified:
- ✅ npx tsc --noEmit passes with zero net new errors
- ✅ npx vitest run passes (161/161)
- ✅ terraform validate passes
- ✅ All existing tests still pass (zero regressions)

All task summaries indicate completion with verification_result: passed.

**Conclusion:** S01 infrastructure foundation is complete and verified. Ready for S02 integration.


## Requirements Advanced

None.

## Requirements Validated

- R018 — Prisma schema now has councilSize (Int @default(3)) column on Task model. S01 provides infrastructure; S04 will add UI form field for user configuration. Column exists and is ready for per-task configuration.
- R032 — CouncilReport type defined with outcome field ('complete' | 'partial' | 'inconclusive'). Stored as Json? column on Task. Type guard isCouncilReport validates structure. S02 will implement logic; S01 provides schema and types to enable flexible failure reporting.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

None.

## Known Limitations

Pre-existing ioredis/bullmq dual-install TS2322 errors (23 baseline errors); new code is correct, errors are in type declarations. Workspace name convention coupling requires manual synchronization with S02 workspace creation code (no compile-time validation). Prisma client generation requires prisma generate command (DB not needed) when migrations are written manually.

## Follow-ups

None — all planned work completed; S02 can begin immediately to wire council step into task-queue pipeline.

## Files Created/Modified

- `prisma/schema.prisma` — Added councilSize + councilReport columns to Task model
- `prisma/migrations/20250409000000_add_council_columns/migration.sql` — Manual migration SQL for council columns
- `src/lib/council/types.ts` — Created council type definitions with type guard
- `src/lib/constants.ts` — Added queue constants and timeout
- `src/lib/workspace/naming.ts` — Added councilWorkspaceName helper
- `src/lib/queue/council-queues.ts` — Created queue infrastructure with singletons and worker factories
- `templates/hive-council/main.tf` — Created Terraform template with Claude CLI support
- `templates/hive-council/Dockerfile` — Copied from hive-verifier
- `templates/hive-council/scripts/init.sh` — Updated README, removed browser references
- `templates/hive-council/scripts/claude-install.sh` — Created Claude CLI install script
- `templates/hive-council/scripts/tools-shell.sh` — Copied from hive-verifier
- `templates/hive-council/scripts/tools-node.sh` — Copied from hive-verifier
- `templates/hive-council/scripts/tools-nvm.sh` — Copied from hive-verifier
- `templates/hive-council/scripts/tools-ci.sh` — Copied from hive-verifier
- `templates/hive-council/scripts/symlinks.sh` — Copied from hive-verifier
- `templates/hive-council/.terraform.lock.hcl` — Copied from hive-verifier
- `src/__tests__/lib/queue/council-queues.test.ts` — Created unit tests for queue infrastructure
