# Informational understanding reports

2026-10-29. Bounded preview implementation; manager execution, polling and production
release remain disabled. No cloud migration was applied by this slice.

The native manager tool now has `report_step`. It accepts the existing structured
report fields: summary, difficulty and reason, issues/resolutions, remaining
uncertainty and next action. These are model-authored statements. The operation
records them without claiming independent verification or creating evidence.

| Operation | Persisted outcome | Required authority |
| --- | --- | --- |
| `report_step` | `reported` | Existing `understand` step, preview phase, exactly `analysis` as its required evidence kind; authenticated owner/host and current fenced attempt |
| `complete_step` | `succeeded` | Existing evidence-backed completion contract, including applicable controller GitHub policy and trusted native completion facts |

There is no new `plan` kind. A planning result can be described in an `understand`
report. Reporting cannot be used for check/review/code-quality, production, mixed
analysis/check, release or migration outcomes. Producer, pass/fail, policy and
evidence-ID assertions are rejected by the strict reporting schema, including an
empty evidence-ID array. A report is not an evidence-ingestion capability.

The report mutation checks owner/task/step/attempt, step version, lease generation,
unexpired lease and current source inside the existing Serializable transaction
and active-registration authorization. It atomically records the `reported` step
and attempt outcome, immutable event/report and notification outbox item. Exact
native-call replay returns the same report; changed content under its event ID
conflicts. Negative checks leave no partial report or notification.

Reporting leaves runtime binding, runtime observation version, `quiescedAt`,
checkout lease and active manager attempt unchanged. A valid reported-understanding
predecessor satisfies **logical dependency bookkeeping**. Every later native claim
still passes the existing writer/reconciliation gates. The tests explicitly show
that the next attempt remains blocked. Reporting does not prove that any process
or external operation ended and does not clear a writer, including an unbound one.

Read projections and the Delivery window separate informational reports from
steps accepted with evidence. Historical report classification comes from its
immutable event, and its displayed revision comes from the original attempt rather
than the task's later head. A reopened or source-invalidated analysis report stays
readable as informational history. Notifications say “Analysis report accepted,”
retain difficulty and original revision, and link to the owner-scoped report.

Two additive local migrations admit the guarded `reported` state and reject SQL
NULL evidence-kind arrays for it. The second guard preserves migration history:
PostgreSQL CHECK permits UNKNOWN, and the legacy array column is nullable at SQL
level. No Prisma model/generator change was needed. Fresh 21-migration and 19→21
upgrade checks preserve user/session/ciphertext, active attempts and historical
report/event/outbox data. Only the two previously recorded schema representations
remain in Prisma diff; this slice adds no new drift.

The [local evidence](informational-report-local/result.json) records PostgreSQL
authority/replay/phase/dependency/notification/invalidation tests, UI distinction
and delivery regressions. Native adapter tests use the actual local runtime with
mocked Responses and no account inference. No production completion is established.

The manager still chooses the task's bounded step graph and optional epic criteria.
Those choices cannot replace controller-required repository checks, independent
review, release criteria or owner approval. An all-understanding graph can finish
reporting; it cannot establish code-quality or production acceptance.

Remaining execution integration is explicit: per-step `activeAttemptId` has no
trusted clearing path, even after a separately verified quiescence observation.
Task-lifetime checkout writer ownership must be distinguished from logical step
attempts. The execution binding identifies the delegated child turn: a root manager
can complete that finished child while its own turn is still running. There is no
general self-turn deadlock in the delegated path. Trusted child observations must
arrive before result acceptance; the first progression pilot should use bounded
observer flush/readback and the existing transactional completion check. A new
pending-result queue is deferred unless recovery evidence demonstrates a need.
The next design must support safe same-manager progression while retaining trusted
drain before handoff or cleanup. This slice deliberately weakens none of those gates.
