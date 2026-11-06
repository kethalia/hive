# Accepted task status after project reopen

Opening an idle project reads its latest accepted task intent for the authenticated owner,
project, workspace, repository and provider account. Eligible queued, preparing or blocked
status remains visible after a page refresh, including its reason and failure stage when
the first status poll fails. The lookup selects status metadata, without loading the prompt
or encrypted payload.

An existing host task takes precedence. The latest intent is selected across all phases
before checking eligibility; a newer running or closed-lifetime intent suppresses older
blocked history. The closed-lifetime check reads at most one matching admission ID.

Opening does not requeue, retry or submit a task. The UI continues polling the same accepted
task identity through the existing status endpoint. Explicit preparation retry retains its
existing guardian and host checks.

Local verification covers owner and repository binding, host-task precedence, preservation
of pending/blocked diagnostics across remounts, rejection of inconsistent status envelopes,
and suppression of older history. The focused and adjacent project suites pass 70 tests;
TypeScript, Biome and `git diff --check` also pass.
