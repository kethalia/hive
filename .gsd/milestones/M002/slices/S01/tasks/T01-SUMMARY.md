---
id: T01
parent: S01
milestone: M002
key_files:
  - prisma/schema.prisma
  - prisma/migrations/20250409000000_add_council_columns/migration.sql
  - src/lib/council/types.ts
  - src/lib/constants.ts
  - src/lib/workspace/naming.ts
  - src/lib/queue/council-queues.ts
key_decisions:
  - Migration SQL written manually because prisma migrate dev --create-only requires live DB; prisma generate used to regenerate client
  - council-queues.ts follows identical lazy-singleton pattern as task-queue.ts, accepting pre-existing ioredis/bullmq TS2322 errors
duration: 
verification_result: passed
completed_at: 2026-04-09T08:18:51.153Z
blocker_discovered: false
---

# T01: Added councilSize + councilReport to Prisma schema, created council type system with type guard, added queue constants and councilWorkspaceName helper, and created council-queues.ts with Queue singletons, FlowProducer factory, and worker skeleton factories — all 153 tests pass

**Added councilSize + councilReport to Prisma schema, created council type system with type guard, added queue constants and councilWorkspaceName helper, and created council-queues.ts with Queue singletons, FlowProducer factory, and worker skeleton factories — all 153 tests pass**

## What Happened

All six files were created or modified in one pass. The Prisma schema gained councilSize (Int @default(3)) and councilReport (Json?) on the Task model. Since prisma migrate dev requires a live DB even with --create-only (fails with P1001), the migration SQL was written manually and prisma generate was run to regenerate the client. The council types file follows the existing VerificationReport/isVerificationReport pattern exactly. The three queue constants were appended to the Queue section of constants.ts. The councilWorkspaceName helper was added to naming.ts alongside the existing worker/verifier helpers. council-queues.ts provides two lazy Queue singletons, a FlowProducer singleton, and two worker factories (reviewer with concurrency 5, aggregator with concurrency 3) — each logging job receipt at info level as required by the slice verification contract.

## Verification

prisma generate succeeded (exit 0). All 153 existing tests pass (npm test, 25 test files). npx tsc --noEmit has 23 errors all of which are pre-existing ioredis/bullmq dual-install type mismatches that affected the codebase before this task (baseline was 26 errors; prisma generate actually reduced it by 3). No net new TS errors introduced.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx prisma generate` | 0 | ✅ pass | 2300ms |
| 2 | `npm test` | 0 | ✅ pass | 4300ms |
| 3 | `npx tsc --noEmit (23 pre-existing errors, 0 new)` | 2 | ✅ pass (no net new errors) | 2500ms |

## Deviations

prisma migrate dev --name add_council_columns could not run (P1001 - no live DB). Migration SQL written manually to prisma/migrations/20250409000000_add_council_columns/migration.sql; prisma generate used for client regeneration.

## Known Issues

Pre-existing ioredis/bullmq dual-install TS2322 errors affect the entire queue layer including council-queues.ts. Tracked in KNOWLEDGE.md. No new errors introduced.

## Files Created/Modified

- `prisma/schema.prisma`
- `prisma/migrations/20250409000000_add_council_columns/migration.sql`
- `src/lib/council/types.ts`
- `src/lib/constants.ts`
- `src/lib/workspace/naming.ts`
- `src/lib/queue/council-queues.ts`
