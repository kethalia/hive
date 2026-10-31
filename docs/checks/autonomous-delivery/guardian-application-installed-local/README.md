# Protected application composition

This local proof connects the actual signed `GuardianService` and PostgreSQL
application store to `openGuardianController`'s fixed private journal readers and
the actual Python accepted-source worker over FD3. It uses real managed Git
objects, detached HEAD, index merge, sealed publication objects and HMAC receipts.

The one composed case exercises:

- A lost reservation acknowledgement, reconstructed outer client, and same-operation
  readback without a second reservation.
- Real source A → B application, retaining dirty, untracked, ignored and
  nonoverlapping staged bytes.
- A lost commit acknowledgement after the server committed, followed by an actual
  Python worker replay. HEAD/index/managed-receipt bytes, inode and mtime remain
  unchanged; the historical expected source remains A.
- HEAD drift injected after the signed applied readback and before outer acceptance.
  The outer retains its hold. Restoring only the fixture's original bytes permits
  fresh verification of the same original receipt; it never reserves or commits again.
- Registration revocation denying subsequent positive verification without changing
  metadata. The physical attempt retains `quiescedAt = null` throughout.

`result.json` binds the source hashes before and after the run and the full test
log. The accompanying service/store cases are included to check the additive
fixture options preserve their defaults. Reproduce with a task-owned loopback
PostgreSQL database containing the current migrations:

```sh
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:35235/hive_delivery_test \
  pnpm exec vitest run \
  src/__tests__/lib/codex-session/guardian-application-installed.integration.test.ts \
  src/__tests__/lib/codex-session/guardian-application-service.integration.test.ts \
  src/__tests__/lib/codex-session/guardian-application.integration.test.ts \
  --no-file-parallelism --reporter=verbose
```

This is **not** a full installed workspace proof. Initial outer enrollment,
native terminal/cohort/router observations and package/process identities are
explicit synthetic fixtures. The real database records the matching synthetic
child completion. The fixture privately rebinds its fake-provider published
operation to those generated database identities before any application, and
never touches a production journal. Factual source-state inputs are derived from
that persisted acceptance; the signed state client is tested separately.

The C guardian/inner-worker FD3 startup is not included here. Application methods
are invoked on the actual outer client directly, while the actual Python worker
uses private FD3. No account inference, GitHub publication, live network request,
cleanup authority, kernel quiescence or model-input release is claimed. Temporary
fixture homes are removed only after overall success and an ESRCH check for every
tracked child process group. Unexpected failure or unresolved groups retain the
private home for diagnosis; no post-reap numeric group signal is sent.
