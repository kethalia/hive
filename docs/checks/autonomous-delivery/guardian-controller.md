# Installed guardian controller checkpoint

This slice replaces the guarded outer launcher's unconditional preparation denial with the real signed controller service. Guardian configuration remains opt-in and requires isolated native execution. Deployment package pins, server guardian/producer flags and the task-start enrollment integration remain separate activation gates. Legacy unguarded hosts retain their existing behavior.

The outer owns a private persistent Ed25519 key. Its public identity signs a fresh server nonce and exact live outer→guardian→worker startup evidence. An issuer-signed one-use grant pins the key, lifetime, independently resolved workspace/build/app, identity and startup digest. The private worker FD3 carries only fixed identity/bootstrap/metadata operations; HTTP exposes exact owner-app POST `/guardian/identity` and `/guardian/bootstrap`, rejects browser Origin, queries and oversized bodies, and has no caller-selected URL or headers. The server factory resolves the current owner/build/app again before each request-local Coder app-cookie exchange.

The exported versioned `GUARDIAN_CONTROLLER_POLICY_DIGEST` describes mandatory server gates and the RO.git policy. It is an identity input, never approval: deployment policy independently pins the package manifest, ELF, Node and policy digests.

For preparation, the outer verifies the inner controller journal's HMAC, exact worker identity and guardian lifetime, then forwards only the immutable preparation tuple. The server independently matches the encrypted persisted task intent. The actual checkout identity is a second immutable record containing lease/incarnation and device/inode. A fresh server fence precedes further helper work. First native launch reserves the complete fixed project inventory once; guarded hosts require RO.git metadata protection and the server's matching approval. Later registered native journal evidence is finalized against current server registration and sealed metadata. Current metadata reads reauthorize through the server and compare the namespace's exact pinned checkout/git identities.

Every signed controller request is durably recorded before sending. A redirect, timeout, malformed acknowledgement, changed local authority or unknown commit outcome leaves a persistent hold, including after reopening. There is no optimistic replay or local receipt-to-execution upgrade. Elective drain still rejects until a fresh complete-root idle snapshot and independent closed barrier can be supplied. Nothing marks tree exit, grants cleanup, sets `quiescedAt` or releases a physical writer anchor.

## Validation

Run against the retained disposable schema24 fixture:

```sh
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:39989/hive_delivery_test \
HIVE_GUARDIAN_CONTROLLER_EVIDENCE_PATH=docs/checks/autonomous-delivery/guardian-controller-local/composition-parent.json \
node scripts/probe-guardian-controller.mjs
```

The probe records exact source hashes before execution and rejects changed sources afterward. It runs 45 runtime/controller/outer tests and 11 PostgreSQL/owner-transport tests. The actual composition builds the pinned C guardian, launches its worker, crosses private FD3 through real owner-app HTTP handlers, signs and verifies actual issuer/outer keys, enrolls into PostgreSQL, admits preparation before an actual Git helper, binds the checkout inode and reserves exactly one native launch. Spoofed browser Origin and query variants reject. Repeated launch rejects. No native registration, producer approval or manager binding is invented.

The composed worker and checkout incarnation are explicit fixtures. Coder identity resolution is mocked, and the full installed host, native namespace/registration and source publication are not exercised by this proof. Native finalization/current metadata have separate journal/crypto unit coverage, including changed metadata rejection. Existing outer tests exercise real tmux and Python PTY ownership/drain; they do not turn the installed authority client's drain hold into a completed gate.

The original fixture failures are preserved in `guardian-controller-local/first-failure.json`: Node fetch did not send the required fixed Host, then the service correctly rejected a private child Node copy whose executable/inode differed from the real outer Node. The corrected fixture uses explicit local HTTP and the same pinned Node executable. No production validation was relaxed.

Queued task reconciliation now invokes authenticated guardian provisioning after checking
the persisted owner/project identity and before sending the preparation request. A failed
or unconfirmed enrollment prevents that request. Existing open enrollment retries recheck
current authority without extending it or restoring revoked producer approval. Twelve
task tests cover the ordering and default-off behavior; twelve service tests cover fresh
enrollment and stale/revoked retries.

The parent also tested the reviewed combined package:198 PostgreSQL checks passed with
one separate opt-in proof skipped,14 package checks and52 compiled behavioral checks passed,
and the actual fixed installer proof passed with the pinned guardian ELF. Typecheck passes.
See `guardian-controller-local/assembled-parent.json` for scope and evidence.

Remaining integration gates are live installed package/pin rollout, the separately reviewed
exact signed callback exception in the private preview guard, real native/RO.git/registration
composition, and fresh bounded full-history idle snapshots for elective drain. No cloud
resources, account credentials or inference were used.
