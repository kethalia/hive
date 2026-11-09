# Guardian registry storage checkpoint

Status: local persistence and producer-fence implementation. No remote migration, flag activation, cloud resource or account inference. The owner/Coder-app bootstrap transport, signed public routes, outer authority factory, native metadata adapter and challenge-bound tree receipt ingestion remain subsequent gates.

Migration `20261029130000_guardian_admission` adds five tenant-bound tables: enrollment grants, runtime lifetimes, project admissions, closed barriers and stop decisions. Existing table columns and writer anchors are unchanged. A partial unique constraint retains one unresolved runtime per workspace/agent slot. Input closure changes phase to `barrier_closed`; it does not certify tree exit or permit a replacement lifetime. No current store method transitions a runtime to `tree_closed`.

The store validates deployment-approved package, ELF, Node and policy pins and independently derives expected private host configuration from verified Coder scope plus deployment issuer/model/isolation settings. Its encoding matches the installed Python writer. Host keys identify the trusted installed software boundary; they are not hardware remote attestation.

The lifecycle separates one-use enrollment, persisted-intent preparation, immutable actual checkout/incarnation/inode binding, a one-use exact whole-inventory first-native launch, and current native-registration/metadata finalization. Historical replay cannot alter package/policy identity, metadata inodes or namespace receipt. Blocked/replaced intent authority is rechecked before stage changes and preparation replay. Native execution fences also require current producer approval. The original preparation digest never gains a fictitious pre-known lease.

`lockProducerAdmission` acquires slot/current registration, runtime, project admission and intent before manager/task locks. It derives Coder ownership from persisted User/slot, checks current registered thread, approved finalized producer, authority expiry and immutable checkout scope. `lockProducerMetadata` returns the sealed checkout/git device/inode inventory under the same current authority; it never reuses the first-native reservation.

`lockManagerCheckout` enforces this gate for manager/native mutations when enabled and for every persisted guarded registration even if the feature is later disabled. It also detects unresolved runtimes before native finalization, so a pending checkout cannot be downgraded into legacy authority. Truly unguarded flag-off registrations retain their existing behavior. Schema24 is therefore a prerequisite for the updated manager/native APIs; missing tables are not silently treated as legacy.

A barrier requires the full admitted set, current server task/attempt/native state and a fresh signed-producer root idle snapshot with exact cursor/sequence/full-history inventory. Terminal step rows alone are insufficient. Preparing, active, blocked or unknown state and unresolved external publication grants defer the entire elective close. Closure serializes behind an in-flight producer transaction and rejects later manager claims/reports/native facts. The persisted stop decision leaves `activeAttemptId` and `quiescedAt` untouched; responses explicitly say `treeExited:false` and `cleanupAuthorized:false`.

## Reproduction and evidence

The retained local fixture is `postgresql://coder@127.0.0.1:39989/hive_delivery_test`, PostgreSQL17 trust loopback, all24 migration checksums verified. Tests create unique owners and retain rows; no global truncate is used. Node/workerd clients were regenerated from this schema. Earlier schema23 at39789 and schema22 at43811 remain unchanged.

```
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:39989/hive_delivery_test \
  node scripts/probe-guardian-registry.mjs

HIVE_GUARDIAN_SOURCE_DATABASE_URL=postgresql://coder@127.0.0.1:39789/hive_delivery_test \
HIVE_GUARDIAN_UPGRADE_PORT=39989 \
  node scripts/probe-guardian-registry-migration.mjs
```

The first command records source-stable actual PostgreSQL lifecycle/concurrency/downgrade tests and policy/config tests in `guardian-registry-local/store.json`. A test-only `HIVE_GUARDIAN_STORE_EVIDENCE_PATH` selects a separate JSON beneath that directory for independent review.

The second makes a consistent dump of the retained23 fixture, restores a separate named database, applies24 and hashes all26 legacy tables before/after. `migration-upgrade.json` preserves counts/hashes, all23 original migration checksums, and exact schema/migration/script digests. Its598 manager bindings and720 attempts remain byte-for-byte unchanged. The upgrade databases and scratch dump remain local for review. A test-only `HIVE_GUARDIAN_UPGRADE_EVIDENCE_PATH` selects a separate output there.

The storage fixture explicitly supplies synthetic owner/Coder/package policy and inode evidence while driving real store transitions before actual native registration. It is not proof that the unimplemented bootstrap signature/outer factory path is available. The original fixture token-digest collision is retained in `first-failure.json`; the global uniqueness constraint was preserved. The first proof-wrapper attempt omitted the historical `0_init` migration name from its timestamp selector and correctly stopped before tests or mutation; the selector now includes that actual migration explicitly.
