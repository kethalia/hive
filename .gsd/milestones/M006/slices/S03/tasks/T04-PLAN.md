---
estimated_steps: 46
estimated_files: 2
skills_used: []
---

# T04: Add scrollback hydration API route and write integration test

## Description

Completes the read path (R047) and proves the full write→read cycle works. Creates a Next.js API route that reads scrollback chunks from Postgres via Prisma, ordered by seqNum, and returns concatenated binary data. Then writes an integration test that spins up a real Postgres connection, writes chunks via ScrollbackWriter, reads them back via the Prisma client, and verifies ordering and content integrity.

The API route is consumed by S04 (client-side hydration UI) — it must return binary data with appropriate content-type so the terminal can replay it directly.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Postgres via Prisma | Return 500 with error message (no stack trace) | Prisma default timeout (5s) | N/A — Prisma validates |
| reconnectId param | Return 400 if missing or not valid UUID | N/A | Return 400 with message |

## Negative Tests

- **Missing reconnectId**: returns 400
- **Invalid UUID format**: returns 400
- **No chunks found**: returns 200 with empty body (not 404 — session may not have output yet)
- **Non-GET method**: returns 405

## Steps

1. Create `src/app/api/terminal/scrollback/route.ts`:
   a. Export async `GET(request: NextRequest)` handler.
   b. Parse `reconnectId` from URL search params. Validate it matches UUID format. Return 400 if missing or invalid.
   c. Query `prisma.scrollbackChunk.findMany({ where: { reconnectId }, orderBy: { seqNum: 'asc' } })` to get all chunks for the session.
   d. If no chunks found, return `new Response(null, { status: 200 })` with `Content-Length: 0`.
   e. Concatenate all chunk `data` fields (Buffer/Uint8Array) into a single response body.
   f. Return with `Content-Type: application/octet-stream` header.
   g. Wrap in try/catch — on error, log and return 500.
2. Create `services/terminal-proxy/test/scrollback-integration.test.ts`:
   a. Import `ScrollbackWriter`, `getPool`, `closePool` from source modules.
   b. Use `describe` block with `beforeAll` that checks `DATABASE_URL` env var — skip entire suite if not set (CI-friendly).
   c. Test: create a ScrollbackWriter, append several buffers of known content, call `flush()`, then query `scrollback_chunks` table directly via the pool to verify chunks exist with correct seqNum ordering and data content.
   d. Test: append data in multiple batches (trigger multiple flushes), verify all chunks have monotonically increasing seqNum.
   e. Test: verify `byteSize` field matches actual data length.
   f. Cleanup: delete test rows from `scrollback_chunks` after each test using the test reconnectId.
   g. `afterAll`: call `closePool()`.
3. Add a simple test for the API route in `src/app/api/terminal/scrollback/__tests__/route.test.ts`:
   a. Test: missing reconnectId → 400.
   b. Test: invalid UUID → 400.
   c. Use Vitest with mocked Prisma client for unit tests (no real DB needed for route logic tests).

## Must-Haves

- [ ] GET /api/terminal/scrollback?reconnectId=... returns binary chunks ordered by seqNum
- [ ] 400 on missing/invalid reconnectId, 200 with empty body on no chunks
- [ ] Integration test proves write→read cycle with real Postgres
- [ ] Integration test verifies seqNum ordering and data integrity
- [ ] Tests skip gracefully when DATABASE_URL is not available

## Verification

- `cd services/terminal-proxy && pnpm test -- scrollback-integration` — integration tests pass (requires DATABASE_URL)
- `test -f src/app/api/terminal/scrollback/route.ts` — API route file exists

## Observability Impact

- Signals added: API route logs `[scrollback] hydration request reconnectId=... chunks=N bytes=M`
- Failure state exposed: 500 response with logged error on Prisma query failure

## Inputs

- ``services/terminal-proxy/src/scrollback-writer.ts` — ScrollbackWriter from T02`
- ``services/terminal-proxy/src/db.ts` — getPool/closePool from T01`
- ``prisma/schema.prisma` — ScrollbackChunk model from T01`
- ``src/lib/db/index.ts` — existing Prisma client singleton`

## Expected Output

- ``src/app/api/terminal/scrollback/route.ts` — Next.js API route for reading scrollback`
- ``services/terminal-proxy/test/scrollback-integration.test.ts` — integration tests for write→read cycle`

## Verification

cd services/terminal-proxy && pnpm test -- scrollback-integration && test -f /home/coder/hive/src/app/api/terminal/scrollback/route.ts
