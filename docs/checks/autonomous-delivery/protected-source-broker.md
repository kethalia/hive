# Protected source broker checkpoint

This module is inert until the fixed installed host composes it with independent
guardian authorization and the verified read-only Git metadata inventory. It is
not a model tool, executable CLI, production activation, or proof of real GitHub
publication. Local tests use real Git plumbing and synthetic HTTP responses.

The former fixture now wraps shared internal plumbing. The protected composition
has no fixture-parent seeding method and refuses unguarded publication. It seals
only explicit paths/deletions, using server-owned author identity and count/size/
path policy. The operation captures its timestamp once and preserves exact raw
bytes and object IDs across retries and subsequent edits to the worktree.

Before importing or sealing, the installed adapter must check current persisted
guardian admission and its pinned checkout/Git directory identities. The adapter
must not replay the one-use first-native reservation or substitute a local receipt.
Parent import reads the exact SHA-verified commit and bounded tree structure into
a private Git object store, with hooks/config/network/filters disabled. Inherited
blob IDs are retained without copying history or large unchanged repository assets.
Symlinks, submodules, alternates and unsupported tree layouts remain explicit holds.

After a server challenge binds the canonical manifest, target, task, source,
producer and provider identity, each HTTP request revalidates the unchanged grant
and metadata authority. Agent-only GitHub authentication is obtained through the
existing fixed Coder helper. One token is pinned for the entire bounded operation,
so identity checks and effects cannot silently use different connected accounts.
Permission is checked again after token retrieval.
HTTP has a fixed origin and bounded methods, paths, body and response;
redirects, ambient proxies and provider error-body output are rejected. Per-socket
timeouts do not bound DNS; the parent must enforce the worker-wide deadline and
kill/reap it on timeout, retaining ambiguous outcomes. No model
chooses a credential, executable, API URL, target ref or publication policy.

Publication creates a unique task/operation ref and draft PR. Exact readback can
recover a lost ref/PR acknowledgement without repeating its POST. A revoked,
ambiguous or interrupted operation stays held with its sealed bytes and journal;
there is no automatic rollback, force push or retry of uncertain effects. A request
already in flight can finish after revocation; final server acceptance must still
revalidate all fences. Local `published` records never grant execution or release.

Fresh final observations include repository/account, commit/tree/parent, ref and
PR identities. Their timestamp starts before the first provider observation, and
the complete collection must finish within ten seconds. The host signer must
persist exact final envelope bytes for retries. Recording a draft PR does not make
it eligible for final quality gates; draft-to-ready is a separate controlled step.

Validation: `python3 -m unittest scripts.agents.test_delivery_source_broker
scripts.agents.test_delivery_source_runtime scripts.agents.test_delivery_source_worker -q` exercises the original nineteen
fixture cases, fourteen protected-composition cases and seven actual FD3 worker cases. The added tests cover
parent import without inherited blob copies, trusted author, sealed-byte reuse,
grant expiry/revocation during authentication and after a remote effect, checkout
replacement, policy bounds, unsupported parent storage, lost acknowledgements,
readback freshness, fixed HTTP routes and sanitized errors, account switching, private IPC scope/sequence checks and
parent EOF. No credential is read
and no live provider request is made in these tests.

The fixed Python worker uses only a private inherited Unix FD3 socket whose peer
credentials match its parent. It never accepts stdin/command-line requests or sends
a token across IPC. Metadata and grant callbacks are typed, bounded and sequential;
wrong replies terminate it. Actual subprocess tests stop before provider access.

Independent review found and closed the per-request credential identity gap and
confirmed the distinction between physical checkout and implementation-attempt
lease generations.

Remaining gates: fixed host signing adapter and worker-wide termination proof,
persisted current-metadata authorization, actual protected native compatibility,
and an installed end-to-end pilot with independently verified provider evidence.
