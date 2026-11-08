# Controlled database changes with automatic Worker Builds

This source slice connects the existing controlled database workflow to the
existing automatic production release journal. It creates no publisher, workflow
file, controller service or required GitHub/Cloudflare token. Production execution
remains disabled unless both the existing owner production policy and the trusted
catalog explicitly authorize it. Actual production cutover remains owner approved.

The catalog pins owner-reviewed SQL/source/recipe intent and deliberately omits
unknown old/new app byte hashes. The fixed trusted compatibility job computes those
hashes from the actual isolated build outputs, completes its scenario and emits the
derived full-plan approval to the separate protected job. Separate protected jobs must
produce corroborated approval, actual SQL/backfill/integrity receipts and activation
receipts. Local old/new compatibility artifacts are hashes of the real isolated
workerd inputs; they are never represented as Cloudflare uploaded artifacts. The
serving proof binds the authenticated Cloudflare app check, exact commit/tree/build,
fixed origin, DB/auth smoke and credential-free database endpoint identity.

A slow controlled build may outlive the original tested-tree grant. The original
proof remains immutable history. A distinct, bounded internal continuation grant
requires the completed correlated job/report and independently refreshed current
CI, review, repository rules, source/tree, policy and native/semantic gates. Reusing
an expired report or replaying the same grant never extends its lifetime.

The future merge ID and request digest are immutable intent only. The existing
journal atomically creates the reserved merge row, freshly authorizes it and marks
it started in one transaction. It retains the original one-inflight-action index.
Crashes before commit roll back; unknown outcomes after commit require lookup and
cannot trigger another dispatch. Report follow-up uses the existing post-response
hook with its own request-scoped database lifetime. A still-running protected job
cannot corroborate its own successful completion.

Local validation uses owned loopback PostgreSQL, real signed manager/native and
independent acceptance transitions, real migration SQL and actual isolated workerd
compatibility tests. GitHub/Cloudflare HTTP and evaluator model output are explicit
local doubles. Tests cover delayed grant renewal, expired grants, changed source or
policy, real lock-wait expiry, reserved-ID substitution, concurrent open/begin,
rollback/unknown acknowledgements, late/lost callbacks, wrong dispatch and serving
database, disabled catalogs, production semantic completion and historical evidence
after deployment-fence release. Deployment health alone does not complete semantic
requirements or release the writer, session, archive or checkout.

The fixed reviewed recipe contains a public authority enrollment manifest, empty
by default. Both protected entrypoints check its origin, signing key, target database
and owner/repository scope before requesting OIDC or reading SQL credentials.
Workflow/catalog inputs cannot select that manifest or executable recipe: the
reusable workflow pins a literal source SHA. Source, wrapper and caller are separate
immutable pin commits; the recipe SHA and OIDC workflow SHA are distinct identities.
Legacy protected-variable jobs retain their existing configuration path.

CI runs these composed cases in a dedicated database and explicitly enrolls the
existing reviewed target migration ledger. Migration 49 is forward-only; applied
migration 47 and frozen migration 48 remain byte-for-byte unchanged. Live enrollment
still needs the existing protected environment/target role and ledger, signing key,
trusted source-build catalog and immutable dispatcher/recipe source. No such live
execution or production database mutation is part of this validation receipt.

The integrated source passed 13 composed PostgreSQL cases, one actual isolated
old/new workerd/PostgreSQL scenario and two source-input/contract cases,
authority/transport contract checks and TypeScript.
Generated host packages preserve the newer epic account/runtime fixes. Cross-checkout
archive reproduction and all five profile mirrors pass with shared dependency-store
references. The host archive is 193,564 bytes compressed (SHA-256
`dcf0a9d53ffcb560e834e51b38795211c38354124196ac8af1e2bb2883c272df`);
the raw tar SHA-256 is
`960a7b3cff01a2712f2e24865abcb522cb254b1bdaefcb2854f1dda0fb000472`.

The review fixes additionally pass all 15 composed PostgreSQL cases. A fixture
inserts the original approval as five-minute-old workflow history, expires the
original tested grant with a real 5.2-second wait, and continues through the actual
scheduler after exactly one report callback. Stale approval/SQL facts grant no new
authority; a newly authenticated controlled report and completed exact run are
required. Lost dispatch acknowledgement produces no duplicate workflow POST.
Activation remains unprepared while the old build serves, then pins the exact
candidate build, tree and observation. A real 30.1-second wait proves subsequent
completed-run lookup uses that pin as history rather than a renewed dispatch grant.
A stalled-provider case cancels callback work at 20 seconds and closes its own SQL
client within the 25-second total budget. Captured SQL references and queued
transaction bodies reject after expiry. The native-wrapper workerd scenario also
verifies both versions share disposable crypto identities and the new version can
decrypt an old-version ciphertext persisted in the isolated fixture database.
These remain local/provider-double checks, with production execution disabled.
