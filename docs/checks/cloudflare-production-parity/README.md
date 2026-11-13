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
- Node and Worker typechecks passed after the workspace database-factory boundary
  correction. Build and hosted acceptance are recorded as separate results below.

`migration-review.json` records fresh and data-preserving 7→11 migration checks.
`preview-migration.json` records the actual Neon Preview upgrade and grants.
`workspaces.json` preserves the primary's inspected reused-workspace identities.

## Hosted and production status

The target Preview is
`https://codex-hive-production-cutover.hive-preview.kethalia.com`.
The existing repository-connected build pipeline published source `4f0e097b`.
Actual headed Chrome passed all thirteen same-site acceptance checks, including
sign-in, ordinary terminals, diagnostics, File Browser's signed app redirect and
repository README listing, subscription creation, provider acceptance and one
browser-reported notification. Test subscriptions, terminal sessions, repository
fixtures and the temporary browser profile were cleaned.

The original `workers.dev` preview passed clipboard uploads, repository terminals,
agent inspection and mobile reload continuity. Its iframe authentication failure
led to the same-site preview domain. The first canonical login exposed the
existing ten-second authentication-client deadline. The bounded Cloudflare login
correction and HTTP error-status preservation passed 47 focused checks and an
independent lifetime review. Hosted sign-in then completed in 3.4 seconds.

The native audio protocol smoke passed readiness, inactive state, heartbeat,
release and clean close. The owned broker, its four children and local sockets
were removed. `browser-hosted/native-audio/` records this hardware-free check.
PCM round-trip and modeled voice were outside that automated check. On
13 November 2026, the owner reported that microphone and speaker testing appeared
to work. This is recorded as user-reported acceptance.

The experimental `CodexVoiceControls` component has no UI caller in merged P01
or this branch. Its separate API authentication test was incorrectly listed as a
cutover gate. Live API validation remains a follow-up for that experimental
component. Hosted template-publication acceptance remains open. The test Coder
account already has the `template-admin` role.

The installed notification hook also passed one callback and durable outbox
processing with the browser closed. Its event reached `delivered` on attempt one.
That separate check had no push subscription. The direct browser test above
proved provider acceptance and visible notification delivery. Hook source
revocation and exact original file restoration both passed.
`notification-hook-hosted.json` records the bounded background check.

The serving production application remains in Kubernetes. On 13 November 2026,
the owner authorized a fresh production start and waived legacy application data
transfer. The fresh production database now has all eleven verified migrations, thirteen
application tables and scoped runtime grants. Its four independent production
secrets are configured on the existing Worker. `fresh-production-initialization.json`
records the checks. Domain activation and live Kubernetes retirement remain pending. The
previous Rancher/source-capture dependency was removed from the cutover gates.
The owner signs in again and configures preferences and notifications after launch.

The migration procedure is in `docs/cloudflare-production-migrations.md`.
Owner merges apply through GitHub. Existing repository-connected Cloudflare Builds
publishes the accepted source. At the approved cutover window, the GitOps retirement stops old writers before
fresh production sign-in. Cloudflare activation and production verification follow,
then remaining application storage is retired. This sequence uses a maintenance window.
