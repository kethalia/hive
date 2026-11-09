# Shared controller policy and manager result checkpoint

2026-10-29. Source and manager execution flags remain default-off. This slice makes
the existing authenticated GitHub publication usable as independent result evidence;
it does not enable runtime execution, polling, release or production acceptance.

`github-policy.server.ts` is the shared parser for the controller's exact
`HIVE_DELIVERY_GITHUB_TARGETS_JSON` task map. It validates the bounded server-owned
configuration and derives the trusted producer from repository ID and the full
normalized policy digest. Neither manager arguments, host environment nor repository
files install that policy. Missing, malformed or removed policy grants no trust.

Policy resolution occurs after signed host authentication and verified persisted
task/project/step/checkout scope. Completion takes an initial policy snapshot, then
resolves it again inside the same Serializable transaction that writes the result.
Changed target, source, policy or authority rejects the write. Registration is locked
and revalidated in that transaction as before. Retry is limited to recognized
serialization conflicts; a failed result leaves no report/completion event/outbox.

Selecting a trusted producer label is insufficient. Every selected reference must
belong to the exact owner/step/source and an immutable `github_evidence_observed`
publication. That publication must have the full current policy digest and required
workflow/reviewer group identities, plus the consumed source challenge and exact
currently configured PR target and checkout binding. A PR-number change at the
same SHA cannot reuse another PR's evidence. Configured review/check criteria remain
mandatory even if the manager declared a check-only step or selected only passing
rows. Empty completion references are explicitly rejected.

The publisher already aggregates all requirements sharing a kind/criterion into one
row. These checks preserve that guarantee: an unavailable/failing second check or
reviewer sharing `C1` cannot be represented by the first requirement's passing
subset. The new regressions establish this behavior, rather than reporting an
existing live bypass. Repository completion still independently checks evidence
status, freshness, invalidation, phase, required kinds and lease/revision fences.

GitHub policy applies to code-quality step kinds `implement`, `review`, `validate`
and `release`, and any step explicitly requiring check/review evidence. Analysis-only
`understand` work does not acquire a PR prerequisite. The subsequent
[informational report checkpoint](informational-reports.md) adds a separate
`reported` outcome for model-authored understanding, without creating trusted
analysis evidence. An informational failed/blocked report can also be recorded
before a PR exists. Neither grants code-quality acceptance or native quiescence.
Change, migration, artifact and independently verified analysis adapters remain
separate work. Repo-wide delivery/release eligibility must continue using
controller requirements, not the manager's choice of informational steps.

Native execution observations remain a separate authority. Accepting a result does
not set `quiescedAt`, clear the active manager writer or prove that background or
external operations ended. Production phase/release remains disabled regardless of
the report. The map is bounded preview configuration; trusted automatic PR discovery,
durable policy administration and live authenticated host/source composition remain
activation gates.

The [local evidence](manager-policy-local/result.json) records 92 tests across nine
files, including twelve new real-PostgreSQL manager-policy tests and six policy
unit tests. They cover signed scope before policy lookup, one durable report/replay,
missing review, failed CI, shared-criterion requirements, false producer provenance,
same-head PR switch, reused policy label, task-policy removal, source/revocation
racing completion, atomic negative results and pre-PR informational failure. Coder,
GitHub and artifact receipts in these fixtures are explicitly synthetic. No cloud
resource, account inference or production data was changed by this slice.
