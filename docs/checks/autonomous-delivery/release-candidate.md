# D09 observation-only release candidate

`ReleaseCandidateResolver` is an internal owner-scoped read. Its caller must
already authenticate the owner; this slice adds no public route or manager tool.
It performs no database/provider write, installs no release credentials or remote
adapter, changes no flags, and grants no merge/deployment capability. Every result
has `mode: observation`, `eligible: false`, `mergeAuthorized: false`, and
`deploymentAuthorized: false`. The intended target is Workers after owner-approved
Cloudflare cutover; the legacy Kubernetes release remains separate.

The resolver reuses the immutable source/attempt resolver and D08 policy adapters,
including their full producer provenance, required repository groups, phase,
invalidation, freshness and pending semantic checks. It does not reinterpret
ordinary successful CI as a task-specific acceptance decision. Understand-only
informational reports remain informational. Noncompleted/canceled steps, pause,
missing source, stale caller source, disabled/revoked/unbound policy and missing
or pending evidence are explicit aggregate blockers. The result omits private
keys, leases, artifact object keys, reports and raw provider errors.

An optional trusted read-only observer receives only persisted repository/PR/head
and base-ref identities. Its ABI requires complete effective rules, exact branch
identity, short freshness, the acting identity's bypass status, required check
selector identities, and full tested head/base/merge/workflow revision/run/attempt
identities. A successful arbitrary workflow cannot stand for a required producer.
Moved head/base, draft/closed PR, incomplete/insufficient rules, missing check
enforcement or a mismatched tested base are blockers. Check success never implies
that GitHub enforces those checks. No production observer factory exists; injected
fixtures are not provider trust. A future adapter must independently fetch these
facts, preserve its credential scope and honor the abort signal.

Observer I/O runs outside the database transaction and has a three-second deadline.
The controller then rereads current source/policy and reruns existing evidence
authorization in a bounded Serializable transaction, so initial facts cannot
survive a concurrent revocation unnoticed. Expired or malformed observations are
unknown. The callback receives no database context; an uncooperative injected
callback is not proof that an underlying network operation stopped after timeout.
There is no effect to retry or capability to retain in this module.

The local assembled tests use actual PostgreSQL, real guardian/policy/manager/
native/source/GitHub evidence services, and explicitly synthetic publication,
artifact and remote-provider dependencies. They verify row hashes remain unchanged
across the resolver read, policy/owner/source isolation, pending semantics/missing
review, exact remote identities/rules, stale proof, concurrent revocation, and
stalled observer cancellation/error redaction. They perform no account inference,
live API write, hosted migration, deployment or activation. The exact source hashes
and checks are recorded in `release-candidate-local/result.json`.

The [prerequisite analysis](release-adapter-prerequisites.md) still applies: an
independent semantic producer, enforced current-base merge policy, durable action
reconciliation, postmerge artifact provenance, controlled Workers promotion,
observation/recovery and F06–F08 acceptance remain outstanding. This observer
cannot authorize the user-reserved bootstrap merge or production cutover.
