# Manager source progression adapter checkpoint

The opt-in `sourceProtocol: 1` adapter keeps each attempt's input source immutable while allowing a protected publication to produce a separately accepted output. The six physical checkout fields, initial source revision, active writer anchor and native lifetime remain unchanged. Execution defaults remain off.

The existing `hive_delivery` tool exposes `publish_source` only with this protocol. Its model input is the bounded change proposal; task, attempt, lease, source, registration and checkout context come from the current claim. The installed `publishSource` callback is mandatory. This checkpoint does not install that callback or grant provider access.

An accepted output B may be reported or completed using independently persisted evidence while the local protected metadata still represents input A. Publication is neither metadata application nor permission to execute against B. Native facts continue carrying A, including exact retries after B exists. The server authenticates that immutable attempt context, preserves exact old acknowledgements, and retains the existing durable conflict path for novel work attributed to a superseded attempt or after publication.

After the root is terminal and its result exists, the adapter calls the installed `applyAcceptedSource` hook. The hook must independently await and verify the complete known child/observer/CLI input boundary; root completion alone is insufficient and can precede child completion. The adapter then independently rereads fresh accepted-source facts and checks `currentSource` is ready at B before journaling local agreement or asking for a continuation. Final outputs are applied without inventing another root turn. The five-second retry window for a definite supervisor-busy response begins after application and readback.

There is no assertion that native collaboration can be frozen during an active turn. A newly observed command or spawn after publication creates a durable hold, preventing application and continuation. Exact duplicate terminal observations keep their original identity and source. Failure, stale state, changed registration, missing local agreement and ambiguous continuation outcomes retain the writer.

## Installed callback contract

`sourceProtocol: 1` requires progression protocol one and these trusted callbacks:

- `currentSource(managerThreadId)` returns `{checkoutBinding, headSha, sourceContext?, phase: "ready" | "updating" | "held"}` from protected local state.
- `publishSource(claimContext, proposal)` invokes the protected publisher. The context contains the physical binding and current registration, manager binding, task, step, attempt, logical attempt lease generation and immutable input source.
- `readAcceptedSource(claimContext, {operationId, revisionId?})` returns the fresh, scope-checked factual `/state` response. It grants no execution or publication authority.
- `applyAcceptedSource(boundaryRequest, acceptedOutput)` composes independent input-barrier and persisted application authorization with the protected metadata helper. Its return value alone cannot establish readiness.

The boundary request contains manager/root/attempt/cursor, registration/server, physical binding, manager binding/task/step, immutable input SHA/context, and the exact observed spawn/cohort set. `currentSourceContext(thread)` exposes only the trusted current claim to an installed publisher composition. `currentAcceptedSource({managerThreadId, taskId, stepId, checkoutBinding})` can supply the fresh accepted output to the collector before local application.

`sourceApplicationSnapshot(thread, boundaryRequest)` supplies a read-only observation checkpoint for the outer application composition. It verifies the exact claim, terminal root, result, known terminal children, acknowledged sequence, absence of pending/unknown inputs, and current MAC-verified private journal. It returns the source journal SHA-256 and observed device/inode alongside the immutable scope and native sequence. The response explicitly says `scope: "native_observer_journal_only"`, `writerHeld: true`, `quiescenceAuthority: false`, and `metadataApplyAuthorized: false`. An atomic journal rewrite may change the observed inode; it is not a standalone authority token.

## Verification and remaining gates

The local Node regressions cover input A → accepted B → completion while local A → terminal application → continuation → next claim/native input B, final-output application, exact historical terminal retries, post-publication root command/spawn/child work holds, apply failure, stale facts, changed model context, protocol downgrade, missing actual local agreement, and snapshot scope/drain checks. Callback and HTTP boundaries are explicit test doubles. They do not prove an installed input barrier or real provider publication.

The PostgreSQL regressions cover immutable original native context and acknowledgements after output acceptance, advanced-input replay across a later output, wrong-context rejection and durable post-publication holds, alongside the existing native and progression suites. Evidence is in [manager-source-local](./manager-source-local/). Its schema-24 run predates the separately owned application-reservation gate; that gate needs its own final combined verification.

Actual supervisor/controller all-input admission, persisted accepted-versus-applied authorization and protected metadata application are separate integration slices. Application is an input boundary under the same writer, not kernel quiescence. Background dirty work need not disappear, and this code never releases the physical writer or authorizes cross-lifetime handoff, workspace cleanup or deployment. Existing native ordering/isolation and guardian requirements still apply. No cloud migration, provider write, production flag or generated bundle is changed by this checkpoint.
