# Bounded independent-acceptance repair checkpoint

This checkpoint lets an installed controller repair a current accepted candidate after an independent semantic failure or a fresh, authenticated required check failure. It does not weaken the task's immutable criteria, repository policy, source chain, attempt budget, registration, metadata authority, or physical writer hold. It adds no model-visible write operation and enables no deployment flag.

The controller waits for the manager root and known child/observer/input boundary. A fixed signed `repair_prepare` request carries no task, policy, feedback or candidate selection. The server derives its exact current binding and accepted source. It stores an immutable `acceptance_repair_reserved` event and a clearly controller-authored factual failure report, and marks that attempt failed. The event pins the original step/dependencies, plan, policy, evaluator, registration, native cursor, lease and immutable feedback. Insufficient material holds; pending checks wait without another manager inference. Check failure must be current under the configured evidence age bound.

The host imports only that exact receipt into its HMAC observer journal. Existing protected source application then advances local metadata without altering worktree bytes. `repair_ready` independently requires the accepted source to have been applied and makes only the same step ready. The same visible manager thread receives a fixed repair prompt with scoped feedback as data. Its first operation must claim that exact step/version. The original attempt remains the physical writer anchor; the new logical attempt starts at the accepted source. Any replacement feedback/step, lost readiness acknowledgement, uncertain inference, changed source/lease/producer, or unknown work holds.

At most two repairs are permitted, also constrained by the original step attempt budget. Pending checks poll at most 30 times, at 60-second intervals, within 30 minutes and the original live authority. This is a wait bound, not a lease extension. Successful acknowledged continuation survives adapter restart without a second inference. Uncertain outcomes are not blindly replayed as execution authority.

## Database fence

Migration33 replaces only `hive_delivery_manager_binding_immutable`. All original immutable identity, source, cursor and writer-drain restrictions remain. The failed-attempt exception requires the same step/task/binding, current accepted source, unexpired original lease, remaining original budget and matching immutable reserved, ready and atomically consumed repair events. The consumed event is inserted in the same transaction before cursor CAS and rolls back with any rejection. A raw failed-to-running cursor update remains rejected. No table or Prisma model is added.

The first composed test correctly failed against the old trigger. Its output is retained in `repair-local/sql-fence-first-failure.txt`. The initial concurrent reservation test also exposed a unique-event race; only the same repair actions may retry the exact aggregate uniqueness conflict under the existing transaction retry limit.

## Evidence and limits

`repair-local/result.json` identifies the exact uncommitted source bytes. The final native proof uses Codex0.165 with a local canned Responses server, one existing manager thread and two independently created evaluator threads. Review of B fails; the manager claims the same step on B and produces C; a fresh evaluator passes C. Actual native turns/history seals, dynamic claim and signed service/PostgreSQL transitions are exercised. Initial enrollment, provider publication, child facts and protected input-barrier receipt are explicit local fixture doubles. No account inference, provider write, kernel quiescence or production task completion is claimed. Required repository checks remain pending after the semantic pass.

The two initial native proof failures were fixture scope errors: missing explicit source context on the second publication, then an unchanged operation-specific branch. Both rejected before accepting the new source, and both logs are preserved. The independently observed source-continuation request mismatch was fixed separately in this checkpoint: applied source context and repair fields now reproduce the supervisor's exact saved request bytes at claim revalidation; the digest comparison remains strict.

Validation:149 runtime/native checks passed (one existing optional skip),37 adapter checks including restart/lostACK passed (one optional native skip),76 focused PostgreSQL checks passed, the actual native+signed PostgreSQL repair proof passed, and typecheck passed. Fresh33 and populated31→frozen32→33 migrations passed;45 old tables and31 migration checksums were unchanged. Schema32 is another agent's release slice and remains independently reviewable;33 itself adds no table.

The approved next slice is controller-authored successful completion when the manager ends while independent checks are pending and never records a result. This checkpoint conservatively holds that case instead of inventing successful manager output. The follow-on must reuse complete repository and semantic evidence checks, exact current candidate and fresh terminal facts, and retain the physical writer.

## Reproduction

The task-private regression DB is `postgresql://coder@127.0.0.1:52047/hive_delivery_test` (fresh33). The acceptance fixture is `postgresql://coder@127.0.0.1:44741/hive_acceptance_test_repair` (31 plus explicit33; the migration upgrade proof separately includes frozen32). Do not apply in-progress migration directories blindly to either fixture.

```sh
HIVE_ACCEPTANCE_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:44741/hive_acceptance_test_repair pnpm exec vitest run src/__tests__/lib/delivery/acceptance-repair.integration.test.ts --no-file-parallelism
HIVE_TEST_NATIVE_CODEX=1 HIVE_ACCEPTANCE_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:44741/hive_acceptance_test_repair HIVE_REPAIR_NATIVE_EVIDENCE_PATH=/tmp/hive-repair-parent-native.json pnpm exec vitest run src/__tests__/lib/delivery/acceptance-repair-native.integration.test.ts --no-file-parallelism
node --test scripts/verify-delivery-manager-adapter.test.mjs
```

No new host bundle entries are required. Existing canonical modules require the parent's normal profile/archive rebuild. Add the two new repair integration tests to the acceptance CI step; the actual native case remains explicit opt-in. Parent owns packaging and deployment.

## Review correction: current source SQL fence

The original checkpoint above is preserved with its original source hashes. Independent review found the failed-attempt SQL exception compared the reservation with the attempt output but did not also compare the task current source. The corrected trigger joins the exact task owner, manager binding, revision ID, version and head SHA. A direct SQL positive control supplies every receipt and succeeds before deliberate rollback; changing only the task current SHA rejects the identical transition. Twelve PostgreSQL cases pass on a new `hive_acceptance_test_fence33` clone with frozen32 and corrected33 deployed once. Earlier applied migration checksums were not edited. See `repair-local/current-source-fence.json` and the two accompanying logs.
