# Signed guardian source application actions

This slice connects the existing application ledger to three default-disabled,
strict signed actions on `POST /api/codex-host/guardians`: `apply_reserve`,
`apply_verify`, and `apply_commit`. The deployment-owned approved package policy,
fresh owner/Coder binding, exact runtime/generation, finalized producer and metadata
pins remain required. `HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED=true` is an additional
gate; this change does not enable it.

The signed generation is checked after the producer lock inside the application
transaction. Authorization expiry and abort are checked again before commit. The
signed frame must remain live through commit; a successful request mints a separate
scoped application grant lasting at most 30 seconds, bounded by current runtime and
registration authority. The outer shortens the returned permission further by the
worker's captured, unextended checkout lease. These grants grant neither execution
nor cleanup authority.

The fixed outer exposes only three inherited-FD methods. The worker supplies the
project/application/operation/source identities; it cannot supply producer policy,
journal digests, metadata hashes or an applied receipt. The outer independently
verifies the fixed controller and supervisor HMAC journals, their identical closed
application record, and the native spool's original MAC and bytes. It checks exact
claim/cursor/source-publication/root/child facts, no pending observer facts and the
recorded native/CLI/terminal input inventory. This is accounted input closure; it
is not a census of background kernel writers or kernel quiescence.

Before signing an applied receipt the outer verifies the fixed Python-managed
receipt using its original canonical bytes, including Python float and Unicode
representations. It opens the sealed checkout and `.git` directories and verifies
HEAD/index through descriptors against the operation journal's device/inode and
content identities. Controller and supervisor must already mirror the accepted
source. Every applied commit ACK and applied readback reopens and checks this
physical evidence after the request completes, comparing it to the original
immutable receipt. Known HEAD/index or signed-receipt drift retains the hold;
a response alone cannot release input. The physical base, lease identity and
original writer anchor remain held.

The outer durably saves the attempted reservation before sending it. Unknown
reserve or commit outcomes keep the exact frame and applied receipt. Only factual
metadata and fresh verification for that same application may pass the resulting
transport hold. A repeated reserve becomes a verification; absence, revocation or
unknown readback retains the hold. Positive `phase: applied` readback recovers a
lost commit ACK without repeating metadata application or changing an old receipt's
timestamp. Other unknown guardian operations keep their existing restart hold.
A trusted operator can restore exact fixture evidence and then obtain a fresh
same-operation readback; the product does not overwrite or repair metadata.
Matching bytes alone cannot recover a replaced index inode. Observed drift and
subsequent recovery do not prove that no outside writes occurred, and retain the
physical writer hold.

Reproduce the bounded local proofs from the primary checkout:

```sh
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:35235/hive_delivery_test \
  node scripts/probe-guardian-application-actions.mjs --service
node scripts/probe-guardian-application-actions.mjs --outer
```

Both helpers record exact source digests and require them to remain unchanged
through the run. `signed-actions.json` covers real PostgreSQL/signing/expiry and
concurrent-generation behavior with fixture completed-native facts. `outer-actions.json`
covers the independent reader, actual inherited-FD guardian transport, tamper and
lost-ACK recovery cases using synthetic server responses. Neither artifact alone
proves the assembled PostgreSQL/Python application path. That composition, package
pin approval and installed activation remain separate gates; no cloud or account
inference is invoked by these proofs.
