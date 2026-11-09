# Effective GitHub merge rules: source fix and proposed enrollment

This is a reviewed-source proposal, not permission to change repository settings.
No ruleset, branch protection, token, paid resource or production authority was
created. The companion `github-effective-merge-rules.proposed.json` is the exact
proposed body for one repository ruleset; it must be separately approved before
any provider mutation.

## Observed gap

Read-only inspection on November 8, 2026 found both `main` and
`codex/delivery-system-design` return 404 from classic branch protection. Main's
effective rules come from six active organization/repository default-branch
rulesets. They require a PR with zero formal approvals, signed commits, and
prevent force pushes/deletion. They do not require strict CI. The epic branch has
no effective rulesets. The two PR rulesets inspected (`14102640` and `14295606`)
have empty bypass lists and target only `~DEFAULT_BRANCH`.

The connected host merge entry (`scripts/host-epic-merge.ts`, also used for
production release) calls `GitHubReleaseRules`. Its former classic-only,
positive-formal-approval requirement therefore blocked the existing flow even
when the independently enrolled exact-head Codex review was clear.

Hive's enrolled review policy already distinguishes a verified Codex bot summary
from formal human reviews. The current docs pilot pins author/provider account
`62855857`, Codex user `199175422`, app `1144995`, and `formalReviewers: []`.
The bot is independent of that author. A provider formal-approval count of zero
can coexist with this application-enforced independent review; it is not itself
review evidence. The source change preserves those exact-head identity, findings,
thread, policy, acceptance and lifecycle checks.

## Source behavior

Normalize classic protection and applicable active inherited rulesets into one
required-PR/strict-CI view. A real classic 404 is permitted only when effective
rulesets supply the missing mandatory gates; 403 and other provider failures hold.
PR review-count zero is supported. A missing PR requirement, non-strict or missing
CI, unbound check producer, bypass actor, changed base, incomplete pagination or
rule drift still holds. Existing classic admin enforcement and empty bypass
requirements remain intact. Rule evidence retains the raw classic/ruleset records
and hashes the normalized effective view as well.

This source change alone does not make today's repository eligible for automatic
merge. Strict provider CI remains necessary: the merge API's expected-head
condition does not atomically freeze the tested base. Removing that guard would
reopen a base-advance race. Provider rules and Hive's review/evidence policy both
must be satisfied.

## Proposed provider change

Add one active repository ruleset covering exactly `refs/heads/main` and
`refs/heads/codex/delivery-system-design`, with no exclusions or bypass actors.
Require PRs, prevent deletion/force pushes and require strict current-base CI from
GitHub Actions app `15368`. Keep the existing zero formal-approval count and
allowed merge methods. Existing inherited signature/PR rules remain untouched.
The proposal does not broaden the source path/risk catalog or enable production.

The four proposed contexts were freshly observed as successful check runs on
`406711f8414e66a0fd6af557c4a3bc283674b71c` (PR417). Workflow `262356269` is active
at `.github/workflows/ci.yml`, which already handles PRs to main and the epic:

| Required check context | Integration ID |
| --- | --- |
| `Build / Lint / Test / Build` | `15368` |
| `Build / Lint / Test / Lint` | `15368` |
| `Build / Lint / Test / Format` | `15368` |
| `Migration preflight / PostgreSQL` | `15368` |

Do not require the currently skipped Typecheck/Test/Coverage or trusted-tree
attestor jobs as substitutes for these actual enrolled contexts. Codex's summary
is verified through the existing independent review policy; do not invent a
nonexistent Codex check context. Other existing repository checks may still run.

This uses an existing GitHub ruleset feature available for public repositories on
GitHub Free; the proposed settings change costs $0 and provisions no service or
credential. It requires repository administration capability through an existing
authorized connection. A missing capability is a hold, not permission to obtain
another token or weaken the rules.

Before any approved application, re-read the current rules, branch heads and exact
check producers. Apply only the reviewed body, preserve the returned ruleset ID,
and re-read effective main/epic rules plus detail/bypass metadata. Existing open
PRs will become subject to strict current-base CI. Keep automatic merge disabled
until an account-backed task proves the exact current review/check/test-tree and
normal journaled merge/readback path. This proposal does not authorize merging
the epic or production cutover.

References: [effective branch rules API](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
[GitHub rulesets and layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).
