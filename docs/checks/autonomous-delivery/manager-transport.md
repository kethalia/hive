# Bounded manager/controller transport

2026-10-29. Bounded implementation following recovery commit `7a0b3da`.
Production execution, release and deployment remain disabled.

The subsequent [checkout binding and native observation checkpoint](native-observation.md)
adds envelope version 2, persisted preparation/source/lease bindings and the
default-off signed native source spool. Its evidence and remaining isolation,
external acceptance and quiescence gates supersede the integration status at the
end of this initial transport design.

## First vertical slice

The registered software host offers narrow native dynamic tools for creating one
task (optionally its initial epic), claiming a step and submitting a structured
success/failure report. The manager uses native collaboration tools to delegate;
Hive observes the actual parent/child/item relationship. Hive does not invent a
child-spawn RPC, duplicate a turn on reconnect, or interpret a model's narrative
as a successful check. One admitted attempt runs at a time.

The installed 0.165.0 generated protocol has `dynamicTools` on `thread/start`
and server `item/tool/call` requests containing native `threadId`, `turnId` and
`callId`. Official [dynamic tool documentation](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)
confirms the request/response flow and marks it experimental. Existing threads
cannot be assumed to gain tools retroactively; installation is explicit at their
creation. Native compatibility and a local mock Responses tool-call test precede
an account-backed pilot. No account credential is copied to the test workspace.

## Authentication and transaction boundary

`POST /api/delivery/host` is default-off and accepts a strict, bounded envelope:
protocol version, registration ID, request/event UUID, operation, native manager
thread/turn/call IDs, issue/expiry timestamps, command payload and Ed25519 proof.
The host signs a domain-separated canonical digest including HTTP method/path,
all envelope fields and payload. The lifetime is at most 60 seconds. The private
host key is held by the installed host adapter and never put in a model prompt,
tool result, command argument or repository.

The server resolves owner and key through persisted registration, checks proof,
rechecks current Coder owner/build through the server-owned Coder client, and
derives project/conversation from the registration's exact thread association.
No payload-supplied owner, producer, Coder URL, endpoint or native path is accepted.
The signature proves the host sent the request; it does not establish evidence
truth or grant release authority.

Every mutation then invokes the registration store's `lockActiveRegistration`
inside the same Serializable repository transaction. Its slot lock serializes
registration replacement, revoke and heartbeat; active generation, server
lifetime, expiry, owner and project/thread association are checked again using
the database clock. A scoped repository authorization callback performs this
check before task writes. Authentication only in route middleware is insufficient.
Task conversation and project must match that registered manager thread; an old
host cannot mutate a new lifetime. Owner read APIs remain the recovery path after
registration revocation.

## Command and authority separation

| Operation | Accepted input | Server action |
| --- | --- | --- |
| `create_task` | Existing task definition; optional initial epic definition | Inject registered project/conversation, validate repo/source policy; create epic and first task atomically with digest-bound task event. Existing epic IDs must match the same owner/project and immutable definition. |
| `claim_step` | Task/step/version/event and policy-requested model/effort | Derive holder from registration/call, reserve fenced attempt; response cannot authorize native execution before trusted runtime binding. Effective settings start unknown. |
| `complete_step` | Existing completion shape with persisted evidence IDs | Check exact attempt/source/version/generation plus registered manager; use repository evidence policy and atomic report/event/outbox. |
| `fail_attempt` | Existing failure shape | Persist informational failed/blocked report; this never proves native or external quiescence. |

Initial epic creation is bounded to creation with its first task. Epic scheduling,
updates and independently versioned epic events remain later work. Manager retry,
reopen, source-change, pause removal and runtime reconciliation are not exposed by
this first transport. Existing task pause and dependency checks still apply.

Trusted runtime observation is a separate adapter path with no manager-controlled
producer field. It derives native identities from the app-server connection and
correlates the reserved operation with exact collaboration item/parent/child IDs.
It binds the registered owner/workspace/build/lifetime and current task revision.
Native turn completion does not imply background processes or external effects
have stopped; unavailable observation keeps those statuses unknown and blocks
retry. A prompt instruction is not an execution sandbox or a checkout lease.
The first native delegation proof is read-only until process/write confinement is
verified against the managed checkout's actual boundary.

## Requested and effective settings

The generated union includes a legacy `collabAgentToolCall` shape, but the actual
0.165.0 runtime's new collaboration tool did not emit it in the native fixture.
With `experimentalRawEvents: true`, the runtime emitted `rawResponseItem/completed`
with `function_call`, namespace `collaboration`, name `spawn_agent`, and requested
settings in its arguments. Its `call_id` exactly matched the `subAgentActivity`
started item ID carrying the real child thread and resolved creation settings.
The narrow observer correlates manager thread, turn and call, discards prompt text
and ignores unrelated raw events. Duplicate events do not duplicate an observation;
conflicting child/settings fail closed. Missing resolved values stay null.
These are creation-time configuration, not billing or per-token inference telemetry.

Official [subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)
documents that custom agent settings can override a spawn request and that agents
inherit parent permissions/provider/MCP servers. Therefore a requested setting
cannot populate an effective field or establish credential isolation. Unsupported
or mismatched policy settings block automatic execution; no silent fallback.

## Evidence and acceptance

The host result route accepts existing evidence IDs only. It cannot call
`recordEvidence`, choose a producer, upload an object key, assert a check status,
or populate trusted runtime observations. A distinct GitHub adapter will fetch
authoritative check/review source records for the stable repository and exact
revision, preserve their digest, then record evidence under its configured producer.
Local tests use an explicitly injected fixture producer and are labelled synthetic.
Production-phase completion and merge/deploy remain disabled regardless of evidence.

Required tests include cross-owner/project/thread attempts; replaced, revoked and
expired registration; signature/path/body tampering; exact replay and changed-body
conflict; revocation racing result ingestion under the shared slot lock; stale lease
and revision; failed report not proving quiescence; forged evidence/producer fields;
unresolved or mismatched model settings; and a real native tool-call fixture with
restart replay producing one durable report/outbox. A real account-backed bounded
delegation and Cloudflare preview are subsequent acceptance gates.

## Ownership and implementation order

Session agent owns registration tables/store/routes and supervisor integration.
Delivery agent owns new manager contracts/service/host route/tests, a new isolated
host adapter module and minimal repository authorization/initial-epic support.
Schema changes beyond the approved registration migration require coordination.
First compile and test the server transport with the actual durable registration
store; then wire native dynamic tools through the supervisor's private connection.
The read bridge remains read-only and receives no execution methods.

Current implementation has a default-off `HIVE_DELIVERY_MANAGER_ENABLED` host route,
durable registration checks inside repository transactions, optional initial epic
creation, digest-bound native call journaling, and a separately callable trusted
`recordNativeDelegation` repository method. That method verifies the bound exact
manager/child/spawn identity, persists observed settings with an audit version, and
pauses scheduling when settings are unknown or mismatch policy. Signed success
reports require verified matching settings. The controller's default evidence
producer allowlist is empty, so enabling the route alone cannot accept success.

The host observer callback and repository method are individually tested; a
deployment-authenticated runtime observation channel, durable offline observation
spool/history reconciliation, external GitHub evidence adapter and installed host
composition are still integration gates. The runtime observer is bounded to 128
delegations per adapter lifetime and the call journal to 1024 entries; hitting a
limit rejects work rather than deleting unacknowledged state. Native tests use an
empty private HOME and a local Responses fixture, including an actual read-only
child creation. They prove installed protocol behavior, not account entitlement,
real inference, billing or production readiness.
