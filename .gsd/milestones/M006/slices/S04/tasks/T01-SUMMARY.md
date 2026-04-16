---
id: T01
parent: S04
milestone: M006
key_files:
  - src/app/api/terminal/scrollback/route.ts
  - src/__tests__/app/api/terminal/scrollback/route.test.ts
  - package.json
key_decisions:
  - Cursor-based backward pagination (seqNum < cursor, desc order, then reverse) rather than offset-based — enables stable pagination as new chunks arrive
  - Default limit 50, max 200 — balances payload size with round-trip count for typical terminal histories
duration: 
verification_result: passed
completed_at: 2026-04-15T17:18:02.114Z
blocker_discovered: false
---

# T01: Extend scrollback API with cursor/limit pagination, X-Total-Chunks header, and install @tanstack/react-virtual + ansi-to-html

**Extend scrollback API with cursor/limit pagination, X-Total-Chunks header, and install @tanstack/react-virtual + ansi-to-html**

## What Happened

Extended the existing scrollback hydration API route (`src/app/api/terminal/scrollback/route.ts`) with cursor-based backward pagination for the virtual scroll history panel. The route now accepts optional `cursor` (seqNum to paginate before) and `limit` (default 50, max 200) query params. When pagination params are present, chunks are fetched in descending seqNum order with a `take` limit, then reversed to ascending before concatenation. A parallel `count()` query provides the `X-Total-Chunks` response header on all successful responses. Backward compatibility is preserved: requests without cursor/limit return all chunks ascending, matching the existing S03 behavior. Input validation rejects non-numeric, zero, and negative values for cursor and limit with 400 responses. Installed `@tanstack/react-virtual` and `ansi-to-html` as workspace dependencies for T03's virtual scroll and ANSI rendering needs.

## Verification

Ran 20 vitest tests covering backward compatibility, cursor/limit pagination, X-Total-Chunks header, input validation (malformed cursor, negative limit, limit=0, cursor=0), boundary conditions (cursor before first chunk, cursor at last chunk, limit larger than available), and database error handling. All 20 tests pass. TypeScript check (`pnpm tsc --noEmit`) shows no new errors — pre-existing errors in task-queue.ts and cleanup.ts are unrelated. Both new dependencies verified importable via `node -e "require(...)"` checks.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/app/api/terminal/scrollback` | 0 | ✅ pass | 207ms |
| 2 | `pnpm tsc --noEmit` | 2 | ✅ pass (no new errors, pre-existing errors in task-queue.ts/cleanup.ts) | 8000ms |
| 3 | `node -e "require('@tanstack/react-virtual'); console.log('OK')"` | 0 | ✅ pass | 100ms |
| 4 | `node -e "require('ansi-to-html'); console.log('OK')"` | 0 | ✅ pass | 100ms |

## Deviations

None

## Known Issues

Pre-existing TypeScript errors in task-queue.ts and cleanup.ts (ioredis version mismatch, WorkspaceWhereUniqueInput type issue) — unrelated to this task.

## Files Created/Modified

- `src/app/api/terminal/scrollback/route.ts`
- `src/__tests__/app/api/terminal/scrollback/route.test.ts`
- `package.json`
