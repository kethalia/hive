# D01 / F04: Codex host-session capability

Date: 2026-10-29. Scope: installed runtime and an isolated local protocol spike; no
production changes, owner credentials, existing conversations, or model inference.
Workspace profile: `software`; image variant: `cli`.

## Decision

**Proceed with a host-owned Codex app-server adapter prototype.** Installed
`codex-cli 0.165.0` demonstrably lets a tmux-hosted Codex CLI and multiple structured
clients join the same live thread. A disconnected structured client recovered
missed shell-command output through persisted history and received subsequent live
events. Rejoining during an active command preserved the same loaded thread.

**F04 is not complete.** This is a real native-runtime protocol check using harmless
shell-command turns, not a Hive Conversation UI or a real model-generation test.
Arbitrary gap-free event replay, approval/question recovery, duplicate input
handling, server restart recovery, and browser integration remain unverified.
No second agent or transcript-file-based imitation of a shared session is needed
for the demonstrated path.

## Reproduce

From the repository, with Node 24, Codex 0.165.0, and tmux installed:

```sh
node --check docs/checks/autonomous-delivery/session-capability-probe.mjs
node docs/checks/autonomous-delivery/session-capability-probe.mjs
```

The [probe](session-capability-probe.mjs) creates a private temporary Codex home,
project directory, loopback-only app-server, and private tmux socket. It passes a
small environment allowlist and an isolated provider configuration with no auth
requirement and an unusable local inference endpoint. It does not send
`turn/start`, a CLI prompt, or a subagent-spawn request. Its only execution
stimuli are fixed `printf` commands and one one-second `sleep`, through
`thread/shellCommand`, with explicit timeouts. This endpoint executes outside the
thread sandbox, so it must not be exposed as an unrestricted web operation.

The CLI starts with `codex resume --remote <loopback-endpoint> <exact-thread-id>`;
no keys or commands are injected into its TUI. The probe reads its own tmux pane
only to assert that the native CLI rendered the known live marker. Terminal text
is test evidence, never the proposed conversation transport. A 60-second deadline
and `finally` cleanup remove only this probe's temporary processes and files.
No specialist workspace was required or created.

## Observed evidence

Final run: exit 0, about four seconds. The exact observed thread ID was
`01a18858-7226-7b12-8b18-901f9d42f354`; it belonged only to the isolated probe and
was removed with its temporary storage. The important emitted results were:

```json
{
  "version": "codex-cli 0.165.0",
  "modelInferenceRequested": false,
  "configuredModel": "gpt-6.1-sol",
  "configuredEffort": "low",
  "emptyThreadResume": "no rollout found",
  "secondClientSameThread": true,
  "bothClientsReceivedSameTurn": true,
  "tmuxCliRenderedLiveMarker": true,
  "reconnectHistoryRecoversOfflineMarker": true,
  "resumeCursorAvailable": true,
  "reconnectReceivesNewLiveTurn": true,
  "activeRejoinStatus": "active",
  "activeSnapshotReconciliation": {
    "uniqueTurns": 5,
    "finalMarkerPresent": true
  },
  "realInferenceAndApprovalRecoveryTested": false,
  "modelCatalogCount": 9,
  "catalogIsAccountEntitlementProof": false,
  "result": "passed"
}
```

`thread/loaded/list` returned exactly the same single thread ID both while the CLI
and two structured clients were attached and after reconnect. Both clients
observed the same completed turn ID. Notifications included `turn/started`,
`turn/completed`, `item/started`, `item/completed`,
`item/commandExecution/outputDelta`, and `thread/status/changed`.

The five controlled turns were seed, live, disconnected, reconnected, and active
rejoin. For the final turn the new client subscribed through `thread/resume`,
buffered notifications, fetched full paginated turn history during execution,
waited for completion, and refetched history. Merging snapshots and completion
events by stable turn ID produced exactly five unique turns and retained the final
output marker. This is evidence for this recovery algorithm and stimulus, not a
proof that every event type is persisted or replayable.

Two exploratory findings are preserved rather than hidden by the final pass:

- A brand-new thread without any persisted turn could not be resumed by the
  second client: RPC error `-32600`, `no rollout found for thread id ...`.
  The final probe reproduces and reports this before seeding history. After the
  seed shell turn, resume succeeds. Do not create a fake shell turn in product
  code to hide this limitation; represent an empty draft before the first real
  turn and test that transition explicitly.
- A first attempt using `codex app-server proxy --sock` against the explicitly
  started Unix listener timed out during initialization. The succeeding probe
  uses documented loopback WebSockets. This does not establish that Unix remote
  mode is broken; proxy/control-socket compatibility needs its own investigation
  before selecting that transport. No existing daemon was inspected or changed.

## Installed interface and semantics

The installed `codex --help`, `codex resume --help`, and `codex app-server --help`
expose remote TUI connections, explicit app-server listeners, schema generation,
and daemon tooling. Generate the exact installed protocol independently with:

```sh
codex app-server generate-ts --experimental --out /tmp/hive-session-capability-schemas
```

These generated types are stronger version-specific evidence than assuming all
current documentation applies to an older runtime:

| Installed type | Relevant contract |
| --- | --- |
| `v2/ThreadResumeParams.ts` | A running `threadId` rejoins that thread; a nonempty `path` becomes a consistency check. For non-running threads, history/path can override the ID. Prefer the ID. |
| `v2/ThreadResumeResponse.ts` | Returns model, reasoning effort, runtime state, optional initial turn page, and backward history cursors. |
| `v2/ThreadTurnsListParams.ts` | Paginated history supports direction and full item hydration. |
| `v2/ThreadItemsListParams.ts` | Item pagination has opaque continuation cursors and per-turn item anchors. |
| `v2/Thread.ts` | Exposes runtime status, parent/session identity, history mode, model, and reasoning effort; the latter two are configuration, explicitly not per-turn execution telemetry. |
| `v2/ThreadItem.ts` | Collaboration tool-call items contain requested model/effort; subagent-activity items contain resolved creation-time model/effort when known. |

“Attach” is the product behavior, not a separate `thread/attach` RPC verified here.
For a running thread on the same server, use `thread/resume` with its exact ID and
no configuration overrides. For a stopped/unloaded thread, resume can reconstruct
execution state from persistence. A separate app-server reading the same stored
history is not evidence of attachment to the existing live executor. Bind the
workspace, server instance, thread, and owner explicitly; do not auto-launch a
replacement executor after an ambiguous disconnect.

Official OpenAI documentation describes the remote CLI connection and
initialization/stream protocol. It marks app-server/WebSocket integration
experimental and unsupported for production. This is a rollout constraint for the
adapter, not a reason to claim an unavailable capability. See
[Codex app-server](https://developers.openai.com/codex/app-server).

## History and reconnect contract

No durable notification sequence or replay-from-event cursor was established by
the official page or generated notification surface. The observed resume cursors
are **history pagination cursors**, not demonstrated event replay positions.
The successful recovery was from persisted state plus live notifications.

The next adapter should initialize and begin buffering before resuming the exact
thread, hydrate history after subscription, reconcile by thread/turn/item ID, and
re-fetch overlapping active/recent turns after hydration and reconnect. Item
updates must replace/reconcile state; blindly appending deltas can duplicate text.
Treat revert/compaction/truncation as state changes, not additional messages.
These are proposed implementation requirements, not capabilities this probe has
already exhaustively tested. The official
[history and event APIs](https://developers.openai.com/codex/app-server) support
the underlying primitives; the application must validate the recovery algorithm.

Do not promise recovery of every transient output delta. Specify and test that
the final visible conversation converges without lost or duplicated messages,
while accurately showing pending work and approvals. Never send an automatic
new turn when opening a view or reconnecting.

## Models and children

The isolated runtime accepted `gpt-6.1-sol` with `low` and returned those configured
values. Its `model/list` returned nine entries. Because this probe has no account
credentials and never requested generation, this is **not** evidence of the
owner's entitlement, actual inference model, token use, price, or successful child
execution. D01's account-level capability gate remains open.

Official [subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
supports explicit spawn model/effort and defaults under `[agents]`. Without an
override children inherit; selecting a model without effort can select its
default effort. Custom agent configuration can take precedence. Children inherit
permissions/provider, so roles do not create credential isolation.

The generated requested/resolved fields above give a concrete implementation path:
record policy-requested settings, compare collaboration-call settings and resolved
subagent-creation settings, and leave missing telemetry unknown. In this desktop
session the exposed collaboration tool also disallows model/effort overrides with
full-history forks; do not assume the orchestrator wrapper and native CLI have
identical constraints. A no-history bounded child test must verify effective
settings and unsupported-setting behavior before automatic model routing is
enabled. It was deliberately not run here because it would incur separate agent
inference and exceed the no-inference probe scope.

## Next bounded implementation

1. Build a host adapter with exact workspace/server/thread binding, one authority
   for starting threads, and read/subscribe operations over the existing
   authenticated Hive transport. Keep the app-server private to the workspace;
   this localhost fixture is not a production network/auth design.
2. Add a minimal Conversation view using the generated 0.165-compatible schema,
   subscribe-before-history reconciliation, and explicit unsupported-version and
   unavailable-session states. Preserve the existing native tmux CLI attachment.
3. Extend fixtures to cover model-message deltas using a local mock inference
   provider, approval/question requests, reconnect mid-item, duplicate sends,
   pagination overlap, revert/compaction, and server crash/restart. Distinguish mock
   inference results from real account validation. Do not infer durable guarantees
   from the shell-only pass.
4. Validate the actual Conversation/Terminal switching and recovery in
   `browser-testing`, preserving evidence in the primary. Only then accept F04's
   two-view requirement. Keep the broader D01 model/child and unattended-control
   gates open until their specific tests pass.

## Adapter slice implemented after the probe

`src/lib/codex-session/protocol.ts` validates a deliberately small display subset
of the installed generated protocol. `adapter.ts` now provides a read/subscription
adapter with exact owner/workspace/build/server/thread binding, listeners installed
before resume, bounded paginated hydration, stable-ID replacement, connection
generation fencing, and explicit empty-draft/unavailable/error states. Its RPC
interface cannot call `thread/start` or `turn/start`. It does not install a host
daemon, modify the existing workspace transport, or launch another executor.

Live text/command deltas are provisional. Buffered deltas are not blindly appended
to snapshots that may already contain them; the view exposes `needsRefresh` until
authoritative refresh reconciles it. Reverts clear the projection, invalidate
in-flight snapshots, and automatically schedule coalesced, generation-fenced
reconciliation with bounded retries. Unknown item kinds appear as placeholders; hidden reasoning
and unknown tool arguments are not retained. Full approval/question presentation,
input mutations, older-history lazy loading, and the web UI remain later slices.
The adapter deliberately fails visibly beyond its supported history/buffer limits.

The injected `AuthorizedSessionTransport` is a contract, **not implemented
authentication**. Its eventual server-side factory must follow the ownership checks
in `src/lib/agents/workspace.ts`: use `getCoderClientForUser`, verify
`workspace.owner_id` against the authenticated Coder user, require a running build
and connected agent, and derive the target server-side. Also authorize the stored
thread/project association and pin the server lifetime identity; client-supplied
thread IDs or a matching TypeScript binding object do not establish access.
Retain credentials on the server, close streams on revocation/build change, enforce
RPC method/payload limits, and fail requests within bounded time. The existing
one-shot SSH operation is an authorization precedent, not a streaming transport
already suitable for Cloudflare. No raw Coder token or arbitrary app-server URL
belongs in a browser request.

Validation: 15 focused Vitest checks cover snapshot/event overlap, duplicate
completion, reconnect without creation, stale-connection responses, draft versus
missing history, changed host binding, other-thread isolation, revert races,
pagination overlap/loops, revocation clearing, unsupported items, and malformed events. Repository
TypeScript checking passed. These use protocol fixtures and complement the real
runtime probe; they do not replace native/browser integration acceptance.


## Authenticated transport follow-up

Committed `e483581` adds the workspace-local, read-only WebSocket bridge, server-side
Ed25519 ticket signer, and browser transport. The native app-server stays on loopback;
short-lived tickets bind the owner, workspace build, server instance, thread and Hive
origin. Renewal keeps one connection; replay state survives process restart. The primary
independently ran all 15 bridge tests, including the real CLI/tmux integration and SIGKILL
recovery, plus 34 browser transport/signer/adapter tests on 2026-10-29.

This implements the bounded transport but does not enable it on a workspace. Trusted
host registration, build-change/revocation observation, per-thread supervision, UI
attachment, and scoped ticket issuance from the authenticated project API remain open.
A pure signing function is not sufficient authorization for those API calls. The
Conversation component exists, but full browser and model-inference acceptance is pending.
