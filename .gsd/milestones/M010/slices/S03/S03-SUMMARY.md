---
id: S03
parent: M010
milestone: M010
provides:
  - ["getTokenStatus(userId) → { status, expiresAt } for any consumer needing token health", "isAuthError/isNetworkError classifiers for error categorization in any queue worker", "Token rotation BullMQ queue and worker for automated key renewal", "TokenExpiryBanner component for dashboard-wide expiry awareness"]
requires:
  []
affects:
  []
key_files:
  - (none)
key_decisions:
  - ["tryDecrypt classifies GCM failures by inspecting error message substrings — standard Node.js crypto error surface for AES-256-GCM", "Optimistic locking via Prisma.$executeRaw instead of findFirst+update to avoid TOCTOU race", "Auth errors (401/403/KEY_MISMATCH) throw UnrecoverableError to prevent BullMQ retry; network errors re-throw for automatic retry", "Version conflict during rotation triggers best-effort cleanup of newly created key to avoid orphaned keys"]
patterns_established:
  - ["tryDecrypt discriminated union pattern — wrap crypto operations and return typed reason codes instead of opaque exceptions", "Optimistic locking via $executeRaw with WHERE version = oldVersion for concurrent-safe DB updates", "Pre-flight check pattern — validate preconditions (token expiry) before expensive operations (workspace creation)", "UnrecoverableError for non-retryable failures vs normal throw for retryable failures in BullMQ workers", "Server action → server component prop pattern for dashboard-wide status indicators"]
observability_surfaces:
  - ["[token-rotation] Rotated/Skipped/Failed log lines with userId and version tracking", "[queue] Auth error — not retrying / Network error — will retry log classification", "CoderToken.version column for rotation count inspection", "CoderToken.expiresAt column for expiry monitoring", "tryDecrypt reason code (key_mismatch | other) for encryption key change diagnosis", "TokenExpiryBanner visual indicator for end-user awareness"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-18T21:05:22.980Z
blocker_discovered: false
---

# S03: Token Lifecycle & Resilience

**Token auto-rotation at 75% lifetime, worker pre-flight expiry check, network vs auth error classification, encryption key change detection, and in-app expiry banner — all with 51 tests passing.**

## What Happened

## What This Slice Delivered

S03 adds the token lifecycle management layer that makes M010's per-user authentication production-ready. Four tasks built the complete system:

**T01 — Schema & Foundation:** Added `expiresAt` nullable timestamp to CoderToken (Prisma migration). Created `tryDecrypt()` returning a discriminated union with `key_mismatch` vs `other` error classification by inspecting GCM auth tag failure messages. Added `listApiKeys` and `deleteApiKey` static methods to CoderClient for key management during rotation. Updated `performLogin` to pass `TOKEN_LIFETIME_SECONDS` (30 days) to API key creation and persist `expiresAt`. Added 5 token lifecycle constants to `constants.ts`. 12 tests.

**T02 — Token Status & Pre-flight:** Created `getTokenStatus()` service that returns `valid | expiring | expired | key_mismatch` by combining DB lookup, tryDecrypt, and expiry threshold checks. Updated `user-client.ts` to use tryDecrypt with typed `KEY_MISMATCH` exception code. Created `isAuthError()` and `isNetworkError()` classifiers in `queue/errors.ts`. Injected pre-flight check into `task-queue.ts` — expired/key_mismatch tokens throw `UnrecoverableError` (no retry), tokens under 2h remaining are refused. Network errors re-throw for BullMQ retry. 17 tests.

**T03 — Token Rotation Worker:** Created BullMQ token rotation queue and processor in `token-rotation.ts`. Processor queries all CoderTokens, calculates effective expiry (falls back to createdAt + 30 days for null expiresAt), and rotates tokens at ≥75% lifetime. Rotation flow: tryDecrypt → createApiKey → encrypt → optimistic-lock UPDATE (WHERE version = oldVersion) → delete old keys. Version conflicts are logged and the newly created key is cleaned up. Key_mismatch tokens are skipped (user must re-login). Worker registered in instrumentation.ts with hourly repeatable scheduler. 11 tests.

**T04 — Expiry Banner:** Created `TokenExpiryBanner` server component using shadcn Alert. Destructive variant with AlertCircle for expired/key_mismatch, default variant with Clock for expiring (shows hours remaining), null for valid. Wired into dashboard layout via `getTokenStatusAction` server action with try/catch silent failure. 5 tests.

## Cross-Task Integration

The four tasks form a dependency chain: T01's tryDecrypt and constants feed T02's token status service, which feeds both T03's rotation processor (skip key_mismatch tokens) and T04's banner display. T02's error classifiers feed the task-queue worker's catch block. T03's rotation worker uses T01's listApiKeys/deleteApiKey for old key cleanup. All modules import from the same constants, ensuring consistent thresholds across rotation, pre-flight, and banner display.

## Observability

- `[token-rotation] Rotated token for user X, version N → N+1` — successful rotation
- `[token-rotation] Skipped — version conflict for user X` — concurrent rotation detected
- `[token-rotation] Skipped — key_mismatch for user X` — user must re-login
- `[token-rotation] createApiKey failed for user X` — Coder API failure
- `[queue] Token expiry pre-flight failed for user X` — job refused
- `[queue] Auth error — not retrying` — 401/403/KEY_MISMATCH → UnrecoverableError
- `[queue] Network error — will retry` — transient failure → BullMQ retry
- tryDecrypt returns typed reason code (key_mismatch | other) instead of opaque exception
- CoderToken.version column tracks rotation count
- CoderToken.expiresAt column enables expiry monitoring

## Verification

## Verification Results

All 51 tests pass across 5 test files (671ms total):

| Test File | Tests | Status |
|-----------|-------|--------|
| `src/__tests__/auth/token-lifecycle.test.ts` | 12 | ✅ pass |
| `src/__tests__/auth/token-status.test.ts` | 6 | ✅ pass (via task-queue-preflight) |
| `src/__tests__/queue/token-rotation.test.ts` | 11 | ✅ pass |
| `src/__tests__/queue/task-queue-preflight.test.ts` | 17 | ✅ pass |
| `src/__tests__/components/token-expiry-banner.test.tsx` | 5 | ✅ pass |

### Must-Have Checks

| Check | Result |
|-------|--------|
| `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts` | ✅ 12/12 pass |
| `pnpm vitest run src/__tests__/queue/token-rotation.test.ts` | ✅ 11/11 pass |
| `pnpm vitest run src/__tests__/queue/task-queue-preflight.test.ts` | ✅ 17/17 pass |
| `pnpm vitest run src/__tests__/components/token-expiry-banner.test.tsx` | ✅ 5/5 pass |
| `pnpm prisma generate` | ✅ client generated |
| `grep -q 'expiresAt' prisma/schema.prisma` | ✅ field present |
| `grep -q 'TOKEN_ROTATION_QUEUE' src/lib/constants.ts` | ✅ constant present |
| `grep -q 'TokenExpiryBanner' "src/app/(dashboard)/layout.tsx"` | ✅ banner wired |

### Known Issue with Verification Command

The plan's must-have check `grep -q 'TokenExpiryBanner' src/app/(dashboard)/layout.tsx` fails with shell syntax error because parentheses in the path require quoting. The actual file exists and contains the import. The fix is to quote the path: `grep -q 'TokenExpiryBanner' "src/app/(dashboard)/layout.tsx"`.

## Requirements Advanced

None.

## Requirements Validated

- R097 — Token rotation BullMQ job with transactional create-encrypt-update-delete flow and optimistic locking. 11 tests pass.
- R098 — Pre-flight check refuses jobs when token expired, key_mismatch, or <2h remaining. UnrecoverableError prevents retry. 17 tests pass.
- R102 — tryDecrypt detects GCM auth tag mismatch as key_mismatch. Propagated through token-status, user-client, rotation, and banner. Tests cover all paths.
- R105 — TokenExpiryBanner in dashboard layout via server action. Destructive alert for expired/key_mismatch, default for expiring, null for valid. 5 tests pass.
- R108 — isAuthError/isNetworkError classifiers in queue/errors.ts. Auth errors throw UnrecoverableError (no retry), network errors re-throw for BullMQ retry. 17 tests pass.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Database was unreachable during execution — migration SQL written manually. Will apply on next prisma migrate deploy. Verification grep command required quoting of parenthesized path segment.

## Known Limitations

Database migration (expiresAt column) written manually because DB was unreachable during execution — will apply on next prisma migrate deploy. The verification command in the slice plan uses unquoted parentheses in the shell path which causes syntax errors — must quote the path as "src/app/(dashboard)/layout.tsx".

## Follow-ups

None.

## Files Created/Modified

- `prisma/schema.prisma` — Added expiresAt DateTime? column to CoderToken model
- `prisma/migrations/20250418200000_add_coder_token_expires_at/migration.sql` — ALTER TABLE migration for expiresAt column
- `src/lib/constants.ts` — Added TOKEN_LIFETIME_SECONDS, TOKEN_ROTATION_THRESHOLD, TOKEN_EXPIRY_WARNING_HOURS, TOKEN_PREFLIGHT_MIN_HOURS, TOKEN_ROTATION_QUEUE
- `src/lib/auth/encryption.ts` — Added tryDecrypt() with DecryptResult discriminated union
- `src/lib/coder/types.ts` — Added ApiKeyInfo and ListApiKeysResponse types
- `src/lib/coder/client.ts` — Added listApiKeys and deleteApiKey static methods
- `src/lib/auth/login.ts` — Updated performLogin with TOKEN_LIFETIME_SECONDS and expiresAt persistence
- `src/lib/auth/token-status.ts` — New getTokenStatus service returning valid/expiring/expired/key_mismatch
- `src/lib/coder/user-client.ts` — Replaced decrypt with tryDecrypt, added KEY_MISMATCH error code
- `src/lib/queue/errors.ts` — New isAuthError and isNetworkError classifiers
- `src/lib/queue/task-queue.ts` — Added pre-flight token check and auth/network error classification
- `src/lib/queue/token-rotation.ts` — New BullMQ token rotation queue, processor, and scheduler
- `src/lib/queue/index.ts` — Exported token rotation worker, queue, and scheduler
- `src/instrumentation.ts` — Registered token rotation worker and scheduler
- `src/lib/auth/actions.ts` — Added getTokenStatusAction server action
- `src/components/token-expiry-banner.tsx` — New TokenExpiryBanner component with shadcn Alert
- `src/app/(dashboard)/layout.tsx` — Wired TokenExpiryBanner into dashboard layout
- `src/__tests__/auth/token-lifecycle.test.ts` — 12 tests for tryDecrypt, listApiKeys, deleteApiKey
- `src/__tests__/auth/token-status.test.ts` — 6 tests for getTokenStatus service
- `src/__tests__/queue/token-rotation.test.ts` — 11 tests for rotation processor
- `src/__tests__/queue/task-queue-preflight.test.ts` — 17 tests for pre-flight and error classifiers
- `src/__tests__/components/token-expiry-banner.test.tsx` — 5 tests for banner component
