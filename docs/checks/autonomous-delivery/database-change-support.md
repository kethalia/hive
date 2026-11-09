# D10 compatible database changes: bounded local foundation

This checkpoint implements an opt-in controlled target-database runner, bounded job, OIDC authority routes and a reusable job workflow. D09 still denies database releases until its database policy and independent mixed-version observer are enrolled. The local PostgreSQL proof exercises real transactions, DDL, mixed-version writes, interruption and recovery. Deployment/authorization observers in that proof are explicit trusted fixtures; no provider, live database, application deployment or destructive contraction was performed.

## Repository contract and supported scope

`docs/autonomous-delivery.md` requires separate expansion, compatible application deployment, resumable backfill, integrity, activation and later contraction. `docs/deployment.md` keeps production migrations forward-only. `services/migrate/src/migrate.mjs` remains the existing controlled Prisma preflight/deploy entry; this slice does not replace or invoke it.

The new `services/migrate/src/delivery` modules implement:

| Durable phase | Next operation | Required observation/effect |
| --- | --- | --- |
| pending | expand | Pinned before-schema fingerprint; reviewed transactional DDL; pinned after-schema fingerprint; frozen high-water key |
| expanded | compatible | Fresh exact old/new application and compatibility observation |
| compatible | backfill | One bounded keyset batch; data, cursor, row count and append-only checkpoint commit together |
| backfilled | integrity | Reviewed full-target constraints/integrity query with zero violations |
| verified | activate | Independent exact activation observation and fresh integrity before/after the observation |
| activated | contract | Records `contract_held`; executes no contraction SQL |

This first supported plan uses positive increasing PostgreSQL bigint keys, a frozen high water mark, reviewed idempotent transformations, transactional expansion and a reviewed dual-write strategy for concurrent old/new clients. New rows beyond the high water mark must already satisfy the new invariant; the integrity query checks the complete target, not only processed rows. Unsupported key spaces, nontransactional DDL, arbitrary model-generated SQL, destructive changes, missing compatibility evidence and failed integrity remain held. A plan's own schema/integrity SQL must cover its full affected surface; the runner cannot discover omitted invariants or infer compatibility from a hash.

`advanceDatabaseChange` is the working automatic processing path: it reads the durable phase, advances only that phase's fixed dependency, yields at a bounded tick/time budget, and resumes from the same run on the next invocation. It stops at a fresh `activation_ready` observation. It never deploys an application or automatically contracts a schema.

## Authority and artifact boundary

The factory is disabled unless `enabled:true`, an exact approved plan digest, a dedicated target connection, a scoped authorization callback and independent deployment observations are supplied by trusted construction. No CLI, HTTP or model tool accepts SQL, credentials, policy, replacement fingerprints or a connection URL. SQL is a trusted reviewed artifact, **not** a sandboxed query language.

The immutable scope binds Hive owner, stable repository ID, environment key, target ID and actual PostgreSQL database name. The plan binds candidate source SHA, old/new application digests, compatibility contract digest, pre/post schema fingerprints and every SQL statement/budget. Each authorization receipt binds scope, plan, exact run and action with a maximum 30-second lifetime. Authorization is checked before effects and again after writes in the same transaction. Target/run/generation and plan mismatches reject; a pending run cannot be adopted by a different run or owner.

A compatibility observation binds those identities plus cursor, high water, checkpoint, current integrity and independently observed compatibility receipt. It is freshly regenerated, not read from cached success; expiry is capped by both authorizations and the deployment observation. `activationAuthorized`, `executionAuthorized` and `contractAuthorized` are false. A digest or this local observation is not a signed release grant.

`ledger.sql` is an explicit **target setup artifact**, not a Hive application migration. It creates a private ledger and immutable checkpoint events and grants nothing to public/application roles. An operator-controlled job role must own the intended target effects; model runtimes and application roles must not receive that role. A trusted job role that can rewrite its own ledger is inside this boundary, not an adversary the hash chain authenticates against.

## Interruption, concurrency and bounds

Each tick uses one Serializable transaction. Data mutations, checkpoint/event and cursor update are atomic. Lost acknowledgement is resolved by reading the current run; a new controller continues from its committed cursor. Backend termination, cancellation, expired post-effect authorization or SQL timeout roll the whole batch back. No implicit retry, backup restoration, rollback DDL or deletion is performed.

A nonblocking database-scoped advisory transaction lock serializes cooperating D10 jobs, followed by the target lock. Statement timeouts are 100–5,000 ms, lock waits 10–1,000 ms, callbacks are bounded to 5 seconds, interactive transactions to 15 seconds and acquisition to 2 seconds. A callback ignoring cancellation cannot retain the transaction through an unbounded await; its late output is ignored. This is bounded safe-boundary cancellation, not a promise that an already-running database statement stops instantly. Schema/query observations are limited to 128 KiB, SQL to 32 KiB per statement and a plan to 128 KiB; batches are 1–1,000 returned keys.

D10 also acquires the reserved PostgreSQL advisory transaction lock used by the pinned Prisma 6.19.3 engine (72707369). The job refuses an altered engine version or override environment; local contention tests exercise both directions. This excludes the pinned Prisma CLI while a D10 transaction is active. It does not exclude arbitrary DDL or ordinary application writes; the operator must gate those separately.

## Concrete installed integration sequence

1. Enroll the repository/environment/target in D09's deployment-owned risk catalog with an explicit database-compatible mode. Keep the existing `application_only` path unchanged until this mode and its fresh verifier are reviewed. Bind baseline release, candidate SHA and immutable migration artifact digest; no task/model metadata selects a different target or SQL.
2. Extend the existing pinned reusable-workflow/OIDC artifact path (`release-build-attestation.server.ts`) to attest a D10 plan artifact: exact repository/workflow ref and SHA, candidate source, plan and compatibility contract digests, old/new app artifacts, pre/post schema versions, and the mixed-version validation result. Verify the complete artifact against that catalog. Reuse this trusted producer path rather than minting authority from a model report.
3. A fixed migration job entry obtains the direct target URL only from its job-scoped secret and the catalog-verified plan from the immutable artifact. The controller supplies the durable run/environment lease identity and narrowly scoped authority. Provision `ledger.sql` explicitly, serialize the existing Prisma migration job and D10 under the same environment gate, then invoke `advanceDatabaseChange` periodically. Cancellation requests stop at a safe checkpoint; a missing/ambiguous receipt retains the hold and reconciles the same run.
4. Supply `observeDeployment` from the existing independent D09 rollout/baseline observer. A successful generic CI job is insufficient: its exact mixed old/new writer/read compatibility contract must match the candidate and schema. The initial compatibility gate means compatible code is available/running in the required controlled stage; it does not activate a new schema-dependent feature prematurely.
5. D09 reads a fresh compatibility observation under its exact release/target lease, verifies producer/artifact/current checkpoint, then authorizes only the compatible application activation. After the real observer confirms activation, `tick('activate')` records that fact. Application rollback is permitted only when the observed prior version remains compatible with the current schema; schema reversal is not implied.
6. Later contraction requires a separately reviewed retention/dependency contract and authority. This implementation deliberately has no contraction executor. Required cleanup cannot be marked complete merely because the application release passed.

The protected reusable workflow `.github/workflows/controlled-database-job.yml` executes only a reviewed checked-out revision, either `approve` (protected plan configuration) or `advance` (the pinned accepted plan and job-scoped direct target secret). A caller must be a pinned `workflow_dispatch` dispatcher, and the exact dispatcher and reusable workflow identity must be enrolled in the authority catalog. Approval and action requests use separate request-bound GitHub OIDC tokens; the controller returns signed responses and grants expire within 20 seconds. Each advance reports its observation ID for the release consumer; repeated invocations reconcile the same run and durable cursor.

The HTTP endpoints are opt-in and must be routed as OIDC transports by the installed application. The installed deployment observer requires separately persisted, fresh D09 provider evidence; it checks the old application is current for compatibility and the new one for activation. The compatibility consumer requires freshly persisted independently verified deployment evidence, not merely a job report or plan assertion. D09 integration and its independent provider observer must be installed and validated together with the trusted compatibility catalog before this can be used as an installed database release. No live provider or production database effect was made.

## Reproduction and evidence

Use only a task-created local database named `hive_d10_test` (the fixture rejects nonlocal hosts/other names). The tests create synthetic tables; the controlled ledger is installed only if absent. They never use a production migration connection. The interruption case kills only its own recorded backend after matching PID, recorded PostgreSQL backend start time, database and fixture application name.

```sh
HIVE_D10_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:<port>/hive_d10_test \
HIVE_D10_EVIDENCE_PATH=/tmp/hive-d10-parent.json \
pnpm exec tsx --test --test-concurrency=1 services/migrate/test/delivery/*.test.mjs
```

Run test files serially: the Prisma lock contention tests intentionally hold the same database-wide lock as the runner tests. A parallel run will correctly report `migration_prisma_busy`.

The local proof covers fresh/empty and populated targets, old-writer/new-reader coexistence, new rows above the high water mark, real backend interruption, lost ACK/restart, concurrent controller rejection, wrong owner/run/application, checkpoint immutability, actual SQL timeout, bounded stalled authority, expired authority after writes, schema drift and post-verification integrity drift. Evidence in `database-change-local/result.json` records source hashes and exact commands. The initial import failure is preserved separately; it used the unsupported default `@prisma/client` path and performed no effects. The corrected fixture uses the repository-generated Prisma client.

Source references: repository files above; [Prisma 6.19 PostgreSQL advisory-lock implementation](https://github.com/prisma/prisma-engines/blob/6.19.0/schema-engine/connectors/sql-schema-connector/src/flavour/postgres.rs). The installed Prisma CLI is 6.19.3; the exact existing runtime path remains separately gated before integration.

## Isolated compatibility producer

The protected compatibility job has no OIDC permission or production database secret. Its enrolled `workerd` configuration pins old and new release archive URLs, canonical app and auth artifact digests, a PostgreSQL image, and a repository-owned scenario script under `scripts/release/compatibility/` by SHA-256. The runner downloads and independently hashes the archives using the release publisher's algorithm, then starts both app/auth pairs under workerd with isolated PostgreSQL, `AUTH_SERVICE`, `ASSETS`, and `DATABASE_URL` bindings. The scenario receives `prepare` before the Workers start and `verify` afterward; its reviewed implementation must initialize the tested schema and exercise the contract through both versions. Configuration and scenario semantics remain an operator review obligation. Artifact URLs must be usable without embedding credentials.

The separate protected attestor uses OIDC. Before accepting the plan the authority independently reads GitHub's exact dispatcher run and successful compatibility job, including repository, attempt, workflow ID and a job name bound to the canonical test configuration digest. Set the read-only Actions token `HIVE_DELIVERY_DATABASE_GITHUB_TOKEN`. The controller binds test configuration to plan, source, app and compatibility digests; D09 separately binds auth digests to its baseline and verified build. The test proves the enrolled isolated scenario, while a separately persisted fresh D09 provider observation verifies the actual current deployment stage. OCI image testing is available as a prototype but is denied for this Worker target.

The local synthetic integration runs two app/auth pairs with real workerd, authentic service and asset bindings, plus a task-local PostgreSQL fixture. It checks tampered scenario/archive rejection, verifies both pairs' responses and exercises PostgreSQL separately. It does not show application-originated PostgreSQL reads/writes and no current built Hive release artifact was available for this proof. The harness currently uses fixed `nodejs_compat`, a pinned compatibility date and `DATABASE_URL`; operators must review any remaining production bindings and ensure the scenario covers the affected behavior before enrolling a real release.
