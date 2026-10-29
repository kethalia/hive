# Native manager turn boundary feasibility

The pinned Codex 0.165.0 runtime supports the proposed completed-root-turn
checkpoint **conditionally on exclusive supervisor input admission**. This local
proof does not implement that admission gate, its durable journal, controller
acceptance, or production host progression. Execution flags remain off.

Run `HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-manager-turn-boundary.mjs`.
The probe uses a fresh private temporary home and empty checkout, a local mocked
Responses provider, synthetic read-only dynamic tools, and the existing canonical
router without modifying it. It reads no account credentials and makes no cloud
or paid inference calls. The JSON evidence records the executable digest, actual
tested source digests, base revision, process lifetime, native identities and
bounds. An uncommitted probe is explicitly labeled as such.

| Actual native observation | Implication for the host |
| --- | --- |
| One root delegates one child, then completes while the child is still `inProgress`. | Root completion alone does not establish a continuation boundary. |
| The canonical router starts two dynamic handlers concurrently. Root terminal history is readable while its detached observer promise remains pending. | Track and drain handlers and observer acknowledgements independently of native completion. |
| After the delayed child finishes, its `subAgentActivity` completion is appended to the already completed root turn. | Re-read old root history after every known child is terminal; an earlier terminal snapshot can be incomplete. |
| `thread/turns/list` with `itemsView: full` and paginated `thread/items/list` return the same root item IDs, including the resolved spawn, both completed dynamic tools/results and delayed child completion. Child history is separately terminal. | Exhaust all bounded cursors, require full view, reject truncation/duplicate/cyclic pages, and reconcile resolved spawn identities against original raw events. |
| A final bounded read has unchanged notification sequence, no pending handlers/observers and no unknown loaded threads. | This is local observation fencing; a changing receive sequence requires another read or a hold. It is not a native global admission watermark. |
| Exactly one continuation produces a new turn ID on the same root thread and unchanged PID/start-time/inode/boot identity; the prior completed frame precedes the new start request. | The minimum same-thread/runtime continuation mechanism is available. A durable exact-request journal and ambiguous-ACK recovery are still required. |
| On a separate control thread, two competing `turn/start` requests during an active turn both succeed with that same active turn ID; their inputs appear in order in its history. | Native does **not** reject competing input producers. Block unauthorized `turn/start`, steer, CLI attachment and other mutation paths at the supervisor boundary. Do not retry an ambiguous start blindly. |

The completed-root checkpoint can therefore be built using this protocol, but
cannot rely on an active-turn JavaScript mutex, a single terminal history read,
or native rejection of concurrent starts. The future host must fail closed for
unknown descendants, incomplete history, pending transport facts, an unresolved
start, or a spawn/work item arriving before the next claim receipt. Invalid work
can still execute natively and remains inside the held writer cohort; it cannot
be retroactively admitted to a new attempt.

The history proof covers the small fixture's native item set. It does not prove
unlimited raw Responses history or untruncated shell output. Persist original raw
spawn settings: resolved history retains call/child/model/effort identities but
does not reconstruct the entire original argument object. No process drain,
background/external operation quiescence, managed lease handoff, controller
transaction, restart recovery or account-backed model behavior is accepted here.

Protocol reference: [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server).
Actual pinned-runtime behavior, including competing starts, is established by
[the local evidence](native-manager-turn-boundary.json), rather than inferred from
current documentation alone.
