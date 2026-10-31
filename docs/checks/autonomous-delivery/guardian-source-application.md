# Guarded accepted-source application persistence

Logical source acceptance and physical checkout metadata application are separate facts. A guarded manager cannot claim another step, admit a new root boundary or publish another source while its current accepted source differs from the latest protected application acknowledgement. This gate starts before a reservation exists. It preserves exact original producing-attempt completion/report/failure under the same claim root and cursor, plus separately authorized factual metadata/state/check reads, immutable native ACK replay and forensic late-event recording. Generic guardian identity and producer liveness fences remain unchanged.

Migration `20261029140000_delivery_source_application` adds one tenant-bound retained ledger. Each row pins the original runtime/admission generations, producer, registration/native root, manager/task/step/producing attempt, publication operation and target/predecessor source, metadata evidence, cursor/native sequence and closed input-barrier snapshot. It records the original physical anchor in the server-derived root-facts bundle. A pending row remains exclusive across expiry, crashes and unknown acknowledgements; there is no expiry transition or replacement-operation escape. Only the exact protected operation can transition `pending → applied`. SQL constraints retain scope, predecessor chain and immutable applied evidence. No physical checkout field, anchor, `quiescedAt` or tree-exit state changes.

The input barrier means no unaccounted native input/tool/child/CLI facts. It does not prove that background kernel writers are absent. The trusted approved outer must independently read and verify the fixed private controller/supervisor/managed HMAC journals before signing typed application evidence; HMAC keys stay on the host. Arbitrary worker-supplied HEAD/index hashes are not application authority. The server authenticates that approved outer boundary and current persisted producer/source tuple, rather than claiming hardware remote attestation.

`GuardianSourceApplicationStore.reserve/verify/commit` run under the current registration/runtime/admission/intent locks, followed by application/manager/task locks. Reservation requires the producing logical attempt and step terminal, exact current cursor and no newer attempt, complete bounded root facts and a fresh closed input-barrier attestation. It does not require the now-finished logical attempt lease to remain live. Runtime/registration and protected producer authority must remain live. Positive results cross the strict authority schema, expire within 30 seconds, retain exact application/barrier/source/producer identity and explicitly grant neither execution nor cleanup permission.

If an `apply_commit` acknowledgement is lost for more than five seconds, the old protected receipt is not rewritten with a fresh timestamp. A fresh same-operation `verify` returns `phase:applied` after current authority/source checks. The regression verifies that the stored applied timestamp, digest and evidence remain unchanged. A changed source, producer, cursor or native fact retains the pending hold instead.

This checkpoint contains persistence and explicit backend action gates. The three draft application actions are strict contracts only: signed service dispatch, the outer fixed-journal reader, FD3 methods and actual local barrier/Python application remain following composed work. No installed factory or deployment flag is enabled.

## Reproduction

The independent schema25 fixture is `127.0.0.1:35235/hive_delivery_test`; earlier schema24/23/22 fixtures remain intact.

```sh
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:35235/hive_delivery_test \
HIVE_GUARDIAN_APPLICATION_EVIDENCE_PATH=docs/checks/autonomous-delivery/guardian-application-local/store-parent.json \
node scripts/probe-guardian-application.mjs

HIVE_APPLICATION_SOURCE_DATABASE_URL=postgresql://coder@127.0.0.1:39989/hive_delivery_test \
HIVE_APPLICATION_UPGRADE_PORT=35235 \
HIVE_APPLICATION_UPGRADE_EVIDENCE_PATH=docs/checks/autonomous-delivery/guardian-application-local/migration-upgrade-parent.json \
node scripts/probe-guardian-application-migration.mjs
```

The eight PostgreSQL cases cover exclusivity/concurrency, accepted-to-reserve gap, exact report exception, protected commit, logical lease expiry, producer revocation, late native facts, immutable database records and delayed lost-ACK verification. Exact source digests and before/after stability are recorded. Owner/package/native/provider/barrier facts are explicit synthetic fixtures; actual database services are exercised, with no account inference or provider calls.

Fresh schema25 migration and a copied schema24→25 upgrade passed. The upgrade preserves all 31 earlier table hashes and all 24 prior migration checksums, including manager/attempt physical anchors. Its new copied database is retained for review. The historical source-state fixture now obtains a real application-store ACK for B before its second claim/publication of C; factual reads still confer no new permission.
