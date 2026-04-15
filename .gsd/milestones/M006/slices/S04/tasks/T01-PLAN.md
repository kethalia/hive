---
estimated_steps: 33
estimated_files: 3
skills_used: []
---

# T01: Extend scrollback API with cursor-based pagination and install UI dependencies

## Description

The existing scrollback API returns ALL chunks as a single binary blob. S04 needs two capabilities from the API: (1) paginated fetching for the history panel's lazy loading, and (2) a total chunk count for scroll position calculation. This task extends the route with `cursor` (seqNum-based) and `limit` query params, adds an `X-Total-Chunks` response header, and maintains backward compatibility (no params = all chunks, existing behavior).

Also installs `@tanstack/react-virtual` and `ansi-to-html` as project dependencies — both needed by T03.

## Threat Surface

- **Abuse**: cursor/limit params are integers from query string — validate as positive integers, cap limit at 200 to prevent unbounded queries
- **Data exposure**: chunks contain raw PTY output (user commands + output), already scoped by reconnectId — no new exposure
- **Input trust**: cursor and limit are user-supplied query params reaching Prisma query — must validate types

## Negative Tests

- **Malformed inputs**: non-numeric cursor, negative limit, limit=0, cursor pointing to non-existent seqNum
- **Boundary conditions**: cursor at first chunk, cursor at last chunk, limit larger than available chunks, empty result set

## Steps

1. Install `@tanstack/react-virtual` and `ansi-to-html` via pnpm.
2. Modify `src/app/api/terminal/scrollback/route.ts`: parse optional `cursor` (number, seqNum to start BEFORE — for backward pagination) and `limit` (number, default 50, max 200) query params. When cursor is provided, add `where: { seqNum: { lt: cursor } }` to the Prisma query. Always apply `orderBy: { seqNum: 'desc' }` for cursor-based pagination (most recent first), then reverse the result array before concatenation so chunks are in ascending order.
3. Add a separate count query: `prisma.scrollbackChunk.count({ where: { reconnectId } })` and set `X-Total-Chunks` response header.
4. Maintain backward compat: when no cursor/limit params, return all chunks ascending (existing behavior).
5. Update existing tests and add new tests for pagination: cursor/limit combinations, boundary conditions, backward compat, malformed params (non-numeric cursor returns 400), X-Total-Chunks header present.
6. Run `pnpm tsc --noEmit` to verify no type errors.

## Must-Haves

- [ ] cursor param filters chunks by seqNum (less than cursor value, for backward pagination)
- [ ] limit param caps result size (default 50, max 200)
- [ ] X-Total-Chunks header on all successful responses
- [ ] No params = all chunks ascending (backward compatible with S03 behavior)
- [ ] Invalid cursor/limit returns 400
- [ ] @tanstack/react-virtual and ansi-to-html installed

## Verification

- `pnpm vitest run src/__tests__/app/api/terminal/scrollback` — all pagination tests pass
- `pnpm tsc --noEmit` — no type errors
- `node -e "require('@tanstack/react-virtual')"` — dependency installed

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Prisma (count query) | Return 500 with error message | Same as error | N/A (Prisma returns typed results) |
| Query params | Return 400 with validation error | N/A | Return 400 with specific message |

## Inputs

- ``src/app/api/terminal/scrollback/route.ts` — existing scrollback API route returning all chunks as binary blob`
- ``src/__tests__/app/api/terminal/scrollback/route.test.ts` — existing route tests to extend`
- ``prisma/schema.prisma` — ScrollbackChunk model with reconnectId, seqNum fields`

## Expected Output

- ``src/app/api/terminal/scrollback/route.ts` — extended with cursor/limit pagination, X-Total-Chunks header`
- ``src/__tests__/app/api/terminal/scrollback/route.test.ts` — updated with pagination test cases`
- ``package.json` — @tanstack/react-virtual and ansi-to-html added as dependencies`

## Verification

pnpm vitest run src/__tests__/app/api/terminal/scrollback && pnpm tsc --noEmit
