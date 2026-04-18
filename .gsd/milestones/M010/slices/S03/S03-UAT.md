# S03: Token Lifecycle & Resilience — UAT

**Milestone:** M010
**Written:** 2026-04-18T21:05:22.981Z

# S03 UAT: Token Lifecycle & Resilience

## Preconditions

- M010 S01 and S02 complete (auth foundation, per-user token rewiring)
- Database migrated with `expiresAt` column on CoderToken
- TOKEN_ENCRYPTION_KEY env var set (64-char hex)
- Redis running for BullMQ queues

---

## Test Case 1: Token Expiry Banner — Expired Token

**Steps:**
1. Log in to Hive dashboard as a user
2. Manually set the user's CoderToken.expiresAt to a past date in the database: `UPDATE coder_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = '<userId>'`
3. Navigate to any dashboard page (e.g., /tasks)

**Expected:** A destructive (red) Alert banner appears above the page content with title "Token Expired" and description instructing the user to log out and log in again. AlertCircle icon is visible.

---

## Test Case 2: Token Expiry Banner — Expiring Soon

**Steps:**
1. Log in to Hive dashboard
2. Set the user's CoderToken.expiresAt to 24 hours from now: `UPDATE coder_tokens SET expires_at = NOW() + INTERVAL '24 hours' WHERE user_id = '<userId>'`
3. Navigate to any dashboard page

**Expected:** A default (non-destructive) Alert banner appears with title "Token Expiring Soon" and description showing approximately "24 hours" remaining. Clock icon is visible.

---

## Test Case 3: Token Expiry Banner — Valid Token

**Steps:**
1. Log in to Hive dashboard with a freshly created token (expiresAt ~30 days out)
2. Navigate to any dashboard page

**Expected:** No banner is visible. Page renders normally.

---

## Test Case 4: Token Expiry Banner — Key Mismatch

**Steps:**
1. Log in to Hive dashboard
2. Change the TOKEN_ENCRYPTION_KEY env var to a different value and restart the server
3. Navigate to any dashboard page

**Expected:** A destructive Alert banner appears with title "Re-authentication Required" and description about encryption key change. User is prompted to log out and log in again.

---

## Test Case 5: Worker Pre-flight — Expired Token Refuses Job

**Steps:**
1. Set a user's CoderToken.expiresAt to a past date
2. Submit a task as that user via the dashboard

**Expected:** The task immediately fails with an error message containing "Token expired for user" — the job is not retried. BullMQ marks the job as failed with UnrecoverableError.

---

## Test Case 6: Worker Pre-flight — Token Under 2h Refuses Job

**Steps:**
1. Set a user's CoderToken.expiresAt to 1 hour from now
2. Submit a task as that user

**Expected:** The task fails with message "Token expires in 1.0h for user ... — below 2h minimum". Job is not retried.

---

## Test Case 7: Worker Pre-flight — Token With >2h Proceeds

**Steps:**
1. Ensure user's CoderToken.expiresAt is >2 hours from now (e.g., 30 days)
2. Submit a task

**Expected:** Task proceeds normally past the pre-flight check into execution.

---

## Test Case 8: Token Rotation — Auto-Rotation at 75% Lifetime

**Steps:**
1. Create a token with expiresAt set to 7.5 days from now (75% of 30-day lifetime has elapsed)
2. Wait for the hourly token rotation job to run (or trigger manually via BullMQ queue)

**Expected:** Check CoderToken row — version should be incremented by 1, expiresAt should be ~30 days from now (new key lifetime), ciphertext/iv/auth_tag should differ from before. Console logs show `[token-rotation] Rotated token for user X, version N → N+1`.

---

## Test Case 9: Token Rotation — Skip Below Threshold

**Steps:**
1. Log in freshly (token at 0% lifetime — full 30 days remaining)
2. Wait for rotation job to run

**Expected:** Token is unchanged. No rotation log messages for this user. Version stays the same.

---

## Test Case 10: Token Rotation — Version Conflict

**Steps:**
1. Set up two rotation jobs running concurrently (reduce interval temporarily)
2. Both attempt to rotate the same token

**Expected:** One succeeds, the other logs `[token-rotation] Skipped — version conflict for user X` and attempts best-effort cleanup of the newly created key. No data corruption.

---

## Test Case 11: Network vs Auth Error Classification

**Steps:**
1. Submit a task, then during execution simulate a 401 response from Coder API
2. Submit another task, simulate ECONNREFUSED from Coder API

**Expected:**
- 401 error: logs `[queue] Auth error — not retrying`, job fails immediately with no retry
- ECONNREFUSED: logs `[queue] Network error — will retry`, job is retried by BullMQ

---

## Edge Cases

- **Null expiresAt (legacy token):** Pre-flight allows the job to proceed (treated as valid). Rotation calculates effective expiry from createdAt + 30 days.
- **Banner fails silently:** If getTokenStatusAction throws (e.g., no session), dashboard renders without banner — no error visible to user.
- **Rotation with key_mismatch:** Token is skipped with log message. User must re-login manually.
- **deleteApiKey failure during rotation:** Old key is not deleted but rotation still succeeds. Old key expires naturally. Warning logged.
