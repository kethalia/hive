# Existing application compatibility and cutover

P01 merged through [PR449](https://github.com/kethalia/hive/pull/449) at `a8ea4384`.
The owner then requested the production Cloudflare move and Kubernetes retirement,
with existing application features ported first. Implementation is on
`codex/hive-production-cutover`. The retirement source is in draft
[PR556](https://github.com/kethalia/k8s-cluster/pull/556).

## Implemented scope

- Workspace commands, file helpers and agent-tool inspection/configuration through
  an owned, current-build Coder PTY.
- Repository terminals with signed clone proofs and ordinary terminal diagnostics.
- Clipboard uploads, native audio and the existing Codex voice signaling protocol.
- Durable notification callbacks and bounded browser push delivery.
- Durable template publication, logs, completion notices and token rotation.
- Per-user background alarms inside the existing Worker, plus hourly repair.
- Additive schema migration, explicit runtime grants and production routing source.

## Checks completed before hosted acceptance

- Broad Vitest run passed 2,161 tests across 187 files, with 55 opt-in tests skipped.
- Separate PostgreSQL run passed all 56 cases across notification, rotation,
  template publication, diagnostics and combined migration suites.
- Independent voice review passed 65 cases, including actual Python/PTY transport
  against a synthetic RFC6455 proxy.
- Actual local workerd/SQLite tests exercised alarms, RPC, transactions, concurrent
  wake preservation, retries and environment isolation.
- The unchanged workspace-template suite passed all 75 cases. Earlier attempts
  reached its 30-second fixture deadline during slow local filesystem I/O.
- Runtime/download/migration-preflight checks passed 48 cases.
- Clipboard-writer tests passed nine actual Python cases.
- Database capture tests passed four cases, including a real concurrent-write,
  same-snapshot archive restoration and fingerprint comparison.
- Node and Worker typechecks passed after the workspace database-factory boundary
  correction. Build and hosted acceptance are recorded as separate results below.

`migration-review.json` records fresh and data-preserving 7→11 migration checks.
`preview-migration.json` records the actual Neon Preview upgrade and grants.
`workspaces.json` preserves the primary's inspected reused-workspace identities.

## Hosted and production status

The target Preview is
`https://codex-hive-production-cutover-hive.b00ste.workers.dev`.
Publication and Browser Testing acceptance are pending. Live provider voice and
production-template activation remain unverified.

The serving production application remains in Kubernetes. A fresh production
capture is blocked by HTTP 401 from the previously supplied Rancher key. The
production database, domain activation and live Kubernetes retirement are pending.
The new Neon production database is empty.

The migration procedure is in `docs/cloudflare-production-migrations.md`.
Owner merges apply through GitHub. Existing repository-connected Cloudflare Builds
publishes the accepted source. The retirement PR follows production verification.
