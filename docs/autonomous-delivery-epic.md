# Epic: observable autonomous delivery

Status: implementation started 2026-10-29; preview and production gates remain open. Owner: Hive delivery manager.
Design contract: [Autonomous delivery](autonomous-delivery.md).
Accepted foundation and release sequence below supersedes the original queue ordering.

## Acceptance criteria

A user describes an outcome in a native Codex manager session. Hive decomposes it when needed,
delegates bounded work with recorded model/reasoning choices, shows durable progress in a native
Delivery window, and notifies on every completed step with a useful report. Eligible changes
reach production through review, checks, migration handling where required, and observation.
Interruptions cannot duplicate external effects or incorrectly advance state. The user can
pause scheduling, inspect evidence, and resolve important decisions without losing their session.

Do not mark this epic complete based on documentation, a UI fixture, a merged PR, or deployment
alone. Preserve pilot evidence in docs/checks/autonomous-delivery/ when real checks are performed.

## Work queue

Capability audits and foundation implementation are underway; remaining tasks are pending.
Current step reports and blockers: [execution ledger](checks/autonomous-delivery/progress.md). Each task follows Understand → Implement → Review →
Validate, adding Release/Observe when it changes deployed behavior. Record attempts, issues,
difficulty with rationale, evidence, and next action on every completed step. Implement small
reviewable slices on the integration branch; keep the final main-targeting PR as a draft until
the release gates below pass. This epic does not authorize local branch merges or rebases.

| ID | Task | Depends on | Done when |
| --- | --- | --- | --- |
| D01 | Audit runtime and release capabilities | Design | Installed Codex interface, model/effort controls, session continuation, GitHub review signals, branch rules, deployment ownership and credentials are verified; unsupported requirements have explicit decisions |
| D02 | Define and implement delivery state/contracts | F03, F04, F05 | Versioned schemas, owner isolation, transition validation, dependency checks, leases, evidence binding and retry budgets pass focused tests |
| D03 | Persist delivery state and outbox | D02, F02 | Additive Prisma migration, transactional event/state/outbox writes, restart reconciliation and duplicate handling pass fresh/upgrade database tests |
| D04 | Add software-workspace manager adapter | D01, D02, D03 | Native manager delegates a bounded task, records requested/effective model and effort, submits structured results, and recovers after interruption without duplicate writes |
| D05 | Add Delivery window | D02, D03 | Native pane shows tasks/steps/reports/notices and manager links with authenticated reads, loading/error states, mobile behavior and preserved terminal instances |
| D06 | Notify every completed step | D03, D05 | Accepted completion creates a durable report and outbox event; push/foreground links select the report; retries, disabled push and cross-device recovery work |
| D07 | Integrate CI and Codex review | D04 | Real review/check results bind to current revision; fallback review is deduplicated; findings are resolved with evidence; absent/stale review blocks eligibility |
| D08 | Enforce repository delivery policy | D07 | Observation mode correctly evaluates real PRs; policy changes require separate authority; changed heads and insufficient evidence cannot merge |
| D09 | Enable controlled production delivery | D05, D06, D08, F06, F07, F08 | Update merge instructions with enforced authorization; GitHub merge, artifact identity, GitOps promotion, smoke checks, observation, pause controls and compatible recovery work end to end |
| D10 | Support migration and backfill steps | D09 | Compatible schema pilot passes fresh/upgrade tests and interruption recovery; backfill/integrity/activation/contract dependencies are enforced |
| D11 | Coordinate epics and bounded parallel work | D04, D07 | Dependencies, work-in-progress limits, writer ownership, re-planning and integrated acceptance are exercised on a real multi-task epic |
| D12 | Bake setup into workspace lifecycle | D04, D06 | New and existing workspaces get versioned adapters through supported installation; hooks/user settings/trust survive; specialists receive no orchestration authority |
| D13 | Pilot, failure drills and onboarding | D05–D12 | Small production fix, compatible migration, and multi-task epic have evidence; failure drills pass; operator docs and actual feature catalog reflect shipped behavior |

D05 can develop against contract fixtures while D04 is implemented. Keep initial execution
concurrency low; only parallelize independent source ownership. D10 is required before enabling
automatic delivery for tasks containing database changes. D09 initially excludes such tasks.
D12 can ship disabled capability assets early; do not auto-enable permissions or hook trust.

## First implementation slice

D01 must establish a supported bridge between the visible manager session and durable execution.
Record CLI version, account-supported models and reasoning, child IDs/results, resume semantics,
external-event wakeup behavior, and scoped auth without printing credentials. Verify existing
review configuration and the complete merge-to-production path rather than infer it from YAML.
Use a harmless disposable assignment; do not mutate production during the audit.

Then build D02–D06 as one vertical capability in small PRs: one task, a few steps, explicit result
submission, server-validated completion, a report in the Delivery window, and a notification.
Keep merge/deployment authority disabled. Prove a restart and duplicate result replay first.

## Repository integration map

| Surface | Existing paths / planned change |
| --- | --- |
| Durable data | packages/db/prisma/schema.prisma and new additive migrations; delivery tables are new |
| Controller | Proposed src/lib/delivery/ for contracts, transitions, policy and reconciliation; target Workers/Workflows; existing startup is a migration source |
| Event ingress | Proposed src/app/api/delivery/ with separate scoped authorization; do not expand notification credentials into release authority |
| Workspace transport | src/lib/agents/workspace.ts and src/lib/actions/agent-tools.ts; existing owner-authorized Coder SSH is a migration source; validate the Cloudflare-compatible bounded transport |
| Canonical adapter packaging | templates/ai-dev-k8s/scripts/agent-tools.py, agent-integrations.sh and main.tf; add delivery assets without changing generic tracking semantics |
| Template synchronization | scripts/sync-workspace-profile-templates.mjs and scripts/verify-agent-tools.test.mjs; software-only orchestration gates |
| Hook integration | scripts/notifications/install.py, scripts/notifications/agent-hook.py and existing config lock; explicit results separate from lifecycle hooks |
| Standalone packaging | existing next.config.ts packaging is a migration source; define Cloudflare-compatible versioned helper distribution |
| Window identity | src/lib/workspaces/general-workspace.ts tool schema/labels/persistence; singleton delivery pane with selected task/step |
| Window rendering | src/components/workspaces/HiveWorkspacePane.tsx and GeneralWorkspace.tsx; proposed DeliveryPanel component |
| Launcher | src/components/terminal/CommandPalette.tsx; Delivery entry under native Hive tools |
| Notifications | src/lib/push/types.ts, event-queue.ts, send.ts and src/components/notification-listener.tsx; persisted delivery events and report deep links |
| Release | .github/workflows/ci.yml, build-images.yml, release-preflight.yml, release.yml and Cloudflare preview/promotion workflows replacing Kubernetes application deployment |

These are integration targets, not an instruction to edit all files in one slice. Adapt names to
existing conventions during implementation. Review current changes before each task.

## Validation and rollout gates

- Unit/domain: invalid transitions, dependency cycles, stale attempts, evidence invalidation,
  policy bypass attempts, bounded retries, model fallback, and safe pause behavior.
- Database/API: owner isolation, credential revocation, unique event keys, concurrent leases,
  atomic state/outbox, transactional retry, and fresh/upgrade migration tests.
- Workspace: version compatibility, unsupported settings, hook merge/lock preservation, offline
  outbox replay, lost native session, known-live session duplication, and specialist restrictions.
- Web: data loading/error/retry, important notices, report selection, pane persistence,
  notification routing and keyboard/mobile accessibility. Real browser work uses browser-testing.
- External adapters: signatures/authentication, duplicate/out-of-order events, review unavailable,
  amended head, ambiguous merge/deployment responses, artifacts with mismatched identity.
- Production: failed smoke checks, compatible rollback, failed/interrupted migration, observation
  not available, and halt of subsequent promotions.

Run narrow checks for each change before broader repository checks. Preserve specialist evidence
in the primary before cleanup. Tests that merely mirror code are not acceptance evidence.
Feature flags default off until the relevant gate passes. Report explicitly what was simulated,
what ran against real integrations, and what was observed in production.

## Remaining decisions to resolve through D01

- Native Codex control interface that supports interactive management plus unattended continuation.
- Actual account/runtime model catalog and supported per-child configuration.
- Authoritative Codex review completion signal and handling of review revisions.
- Trusted controller deployment identity and policy administration boundary.
- Exact GitOps promotion target, production telemetry, and compatible recovery authority.
- Evidence retention limits and detailed-report payload limits for the deployment.

These are implementation investigations, not blanket requests for user approval. Escalate only
where evidence cannot resolve a choice or the choice changes product behavior/authority.


## Revised foundation roadmap (accepted 2026-10-29)

The original D01–D13 tasks remain delivery-system scope. Add these foundation tasks before the
relevant dependents; preserve IDs so evidence and progress links remain stable. See the execution ledger for current status.

| ID | Task | Depends on | Done when |
| --- | --- | --- | --- |
| F01 | Configure one Coder host and simplify login | D01 | Server-owned CODER_URL targets coder.kethalia.com; URL input removed; credentials, existing sessions, expiry, owner isolation and origin overrides tested |
| F02 | Cloudflare and Neon compatibility preview | D01 | Authenticated API, supported framework build, Prisma/PostgreSQL access, required transactions, terminal connection and scoped workspace operations work from preview |
| F03 | Discover projects from Coder-connected GitHub | F01 | Accessible repos paginate/search without cloning; stable IDs survive renames; revoked access is handled |
| F04 | One host session, two project views | D01, F02 | History plus live events render; tmux CLI uses same running thread; switching/reconnecting loses no messages and starts no duplicate agent |
| F05 | Managed checkout preparation and recovery | F03, F04 | Work prepares source on demand; conversation remains readable without checkout; resume restores correct path/revision; existing clones remain protected |
| F06 | Durable preservation and safe cleanup | F05, D03 | Evidence stored in R2; completed managed checkout can be removed safely and re-created; ignored/untracked files and active consumers block unsafe deletion |
| F07 | Replace origin-bound background services | F02, D03 | Workflows/Queues cover required jobs, retries, notifications and event waits; no hidden Kubernetes Hive service dependency remains |
| F08 | Rehearse data migration and application cutover | F02, F07, D05, D06 | Existing PostgreSQL data moves to Neon with integrity checks; secrets/session behavior, R2, streaming, backup and recovery rehearsed |

F02 is a capability gate, not a production cutover. Build F04 early: shared-session attachment is a
core requirement, not something to discover after building the conversation UI. Use the smallest
prototype before visual polish. F06 cleanup additionally requires the completed delivery evidence
specified by policy; it may be validated with controlled fixtures before production pilot use.
D09 production enablement also depends on F06–F08. D12 packages F04/F05/F06 workspace capabilities.
Update accepted requirements and cross-references when implementation evidence changes this sequence.

## Branch, review, preview, and release strategy

Use one long-lived integration branch for this bounded major project. The current branch is
`codex/delivery-system-design`; it can remain the integration branch rather than creating a new
clone or restarting the task. Preserve the primary checkout and isolate only concurrent work.
Create Conventional Commit slices and obtain review incrementally. If child branches are needed,
use GitHub PRs into the integration branch; never merge/rebase locally under the current policy.
Keep one draft PR from the integration branch to main while work remains. No force pushes.

A single branch does not mean a single final validation pass. Run narrow checks after every slice,
CI regularly, and deploy integration revisions to isolated Cloudflare preview environments backed
by separate Neon test data and R2 namespaces/buckets. Do not point development deployments at live
production credentials/data by default. Track exact source revision and deployed artifact identity.
Maintain a requirements-to-evidence matrix for all accepted features, including features already
working today. Check drift from main regularly; reconcile through an authorized GitHub workflow,
not an unrequested local merge/rebase. Keep schema changes backward-compatible where feasible.

The intended sequence is:

1. Complete foundation prototypes and document remaining capability gaps.
2. Implement and review small integration-branch slices; keep production on the existing release.
3. Deploy the complete release candidate to Cloudflare preview; validate real browser, auth,
   shared sessions, notifications, workflow recovery, migration, and rollback behavior.
4. Rehearse production-data migration with sanitized data or tightly controlled access, record
   integrity checks, and choose the cutover write strategy. Prefer a bounded maintenance window
   for the initial migration over unproven dual writes. Define how post-cutover writes are handled
   before claiming that routing back to the old database is a safe rollback.
5. Mark the final PR ready only after implementation scope is complete and preview/rehearsal gates pass. Merge
   through GitHub under the effective policy, build/identify the main revision's release artifacts,
   and validate them before promotion. Do not assume a PR artifact equals the merged artifact.
6. Cut over the production application and database using the rehearsed plan, release the version,
   and verify real production behavior through the observation window. Keep the old deployment
   recoverable until the defined retirement gate; no automatic deletion of cluster resources.
7. Close the epic only after production verification, migration cleanup, and preservation evidence
   are complete. Update the feature catalog/runbooks and clean up managed task resources.

Clarification: the full candidate should already work on Cloudflare **preview before merge**.
Production cutover and production-only verification necessarily occur at/after release. Do not
claim full production validation before production traffic reaches the new deployment. If a canary
is selected later, define its data/routing isolation and rollback conditions explicitly.

User preference is to keep main unchanged by this project until the complete candidate is validated.
The initial bootstrap release is governed by the current human-merge policy. Automatic release
capabilities built by this epic are enabled only after their own gates and authority changes pass.
No workspace/template rollout or production mutation is authorized merely by recording this plan.

## Immediate next task

The initial F02/F04 probes and real-account manager/child pilot have passed their bounded gates.
Continue D04 with the reviewed server progression contract: prove several logical steps through
the installed native manager while retaining one checkout writer. Keep replayed claim
acknowledgements non-runnable until trusted recovery is established.

In parallel, implement the [guardian ownership design](checks/autonomous-delivery/native-guardian-design.md)
for safe whole-runtime drain and the [source publication design](checks/autonomous-delivery/source-advance-design.md)
for immutable input/output revisions and a controlled GitHub publisher. These are separate
authority boundaries: step completion does not prove process shutdown, and publication does not
prove CI, review or release eligibility. Compose and validate them before enabling cleanup or
unattended publication in the test workspace.

Complete D05 scheduling controls and manager navigation, then repeat authenticated browser
acceptance with the integrated candidate. F07 baseline compatibility, durable background work,
F08 migration/cutover rehearsals and the remaining D-task gates still follow. The execution
ledger records completed slices and remaining validation; this sequence does not mark those
broader milestones complete.


### Bootstrap acceptance versus epic completion

Each task with production criteria has two explicit milestones: implementation/preview accepted
(premerge) and activated/production verified (postmerge). D09, D10 and D13 must have implementation,
preview pilots and recovery rehearsals accepted before bootstrap merge; their real production pilots
remain pending until afterward. A ready bootstrap PR does not close these tasks or the epic. Show
those pending production criteria in the final PR and Delivery window. This avoids requiring a
production release as a prerequisite to the merge that creates that release. Unexpected production
findings become reviewed follow-up fixes; do not promise that preview proves all live behavior.
