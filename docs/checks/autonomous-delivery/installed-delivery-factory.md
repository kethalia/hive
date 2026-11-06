# Installed delivery factory (default off)

This checkpoint composes the existing manager/native observer, source publisher,
factual source-state client, protected metadata application, and GitHub collector
in the installed host. It does not enable an installed workspace or establish an
end-to-end account-backed delivery result.

`deliveryExecutionEnabled: true` is a separate explicit opt-in. It requires
manager, guardian, native isolation, metadata read-only protection, and exactly
one prepared project in the native lifetime. Manager-only configurations retain
their previous behavior. Deployment-derived configuration includes the new field
only when `HIVE_DELIVERY_EXECUTION_ENABLED=true`; otherwise existing configuration
bytes/digests are unchanged. The installer rejects inconsistent combinations.

The factory derives source scope from the current registered manager claim and
verified physical checkout context. It uses installed fixed helpers and private
state directories, never model-selected helper paths, keys, repositories, or
producer identities. The existing publisher creates/verifies the policy-approved
PR; this factory adds no merge or deployment authority. Protected application
continues to require terminal root/cohort and input closure, fresh signed server
reservation/verification, and exact applied readback. Physical writer holds remain.

After an accepted publication has been durably recorded by the actual adapter,
the collector can refresh that exact active claim's accepted source. Its signed
challenge independently supplies the current PR/provider scope. Refresh is bounded
and scheduled every 60 seconds while the same live claim remains valid. Missing
PR, pause, revocation, scope changes, or uncertain responses stop automatic refresh
and yield a pending prerequisite, not evidence. `deliveryStatus()` is an installed
trusted read seam; a model-facing status/refresh tool is still a separate review
and implementation prerequisite for the complete autonomous flow.

Native and registration revocation subscriptions synchronously abort network
requests and clear polling. Every callback also rejects closed/revoked native
state, dead runtime, changed lifetime, and revoked execution. Late transport ACKs
are discarded even when the transport ignores AbortSignal. The four guardian FD3
callbacks are independently checked before and after awaiting, and race lifetime
abort. The source coordinator receives that trusted lifetime signal and propagates
it to its bounded waits and fixed apply worker; ambiguous reserve/commit outcomes
retain the original operation and input hold. Tests cover late replies from all
four guardian methods, stalled factory metadata on registration revocation, and
actual private-FD worker abort, SIGKILL and completed reap with no input release.
Host closure starts
factory shutdown before waiting for controller/native teardown. Factory shutdown
has an eight-second deadline: exhaustion is an uncertain hold, not a successful
process-drain claim. The fixed collector helper has its existing independent
55-second maximum; the factory adds no arbitrary helper injection for tests. Only
the guardian can establish eventual descendant termination.

Validation in `installed-delivery-factory-local/result.json` covers actual adapter
composition and Ed25519 manager/native/source-policy requests, synthetic known
child facts, rejection before provider effects, config compatibility, and stalled
transport revocation. It does not yet exercise a full factory source advance with
real PostgreSQL services, protected worker and provider doubles together. That is
the next composed fixture, followed by reviewed installed packaging and a bounded
test-workspace pilot. No production flag, template activation, cloud resource, or
account inference changed in this checkpoint.

Parent packaging must add `codex-delivery-runtime.mjs` to the curated module list
and register `scripts/verify-codex-delivery-runtime.test.mjs` in runtime/compiled
checks. Existing source-worker/apply-worker/provider/collector assets are reused.
