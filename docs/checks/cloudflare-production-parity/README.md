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

- Broad Vitest run passed 2,195 tests across 190 files, with 59 opt-in tests skipped.
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
`https://codex-hive-production-cutover.hive-preview.kethalia.com`.
The original `workers.dev` build was published by the connected push-triggered
pipeline and passed hosted terminal, repository, clipboard, agent-inspection,
diagnostic and mobile checks. File Browser reached Coder login after local-network
permission was granted, which held iframe acceptance. The same-site Preview is
published through the connected build pipeline. Its first login attempts reached
the existing ten-second authentication-client deadline. Read-only database checks
confirmed that the authentication domain created sessions after those callers
timed out. A Cloudflare-specific bounded login deadline correction is being checked
before repeating the same-site browser acceptance.

Chrome push registration remains unverified after a browser permission error.
Authenticated live voice metadata remains unverified because the test workspace's
default Codex CLI was signed out. Production-template activation remains unverified.

The serving production application remains in Kubernetes. A fresh production
capture is blocked by HTTP 401 from the previously supplied Rancher key. The
production database, domain activation and live Kubernetes retirement are pending.
The new Neon production database is empty.

The migration procedure is in `docs/cloudflare-production-migrations.md`.
Owner merges apply through GitHub. Existing repository-connected Cloudflare Builds
publishes the accepted source. The retirement PR follows production verification.
