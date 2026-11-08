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
Current implementation checkpoint (2026-11-08): the epic preserves released main
`1ace8774118b99b28856347edd51410c4f0a0774`. Preview task integration, automatic
production Builds observation, independent production acceptance, and explicit owner-gated
production Builds deployment are integrated after CI/review. Both existing Preview databases
have migration48; production remains unchanged. The retained private 20Gi test host restarts
automatically with signed history preserved. A source fix for Coder fsGroup HOME account
locking is in review before the current manager/child pilot. Database source-build delivery
and graceful account maintenance/resume are still being implemented and validated. Installed
multi-task, shared Conversation/Terminal browser acceptance, background wake approval and
final production cutover remain open.

A read-only production capture has now been restored and upgraded both locally and in a separate
Neon Free rehearsal database: all eight original tables (88 rows) match their fingerprints,
and all 39 migrations are present. The actual Worker application/session proof and local backup recovery also pass within the
recorded limits. Original production keys/session continuity, streaming and final cutover
checks remain open. The raw data stays in private files and the isolated database; only redacted
proof is committed. The previous private Cloudflare browser pilot covered login, repository
search/enrollment, layout and logout; current-build shared-session and full baseline acceptance
remain pending. No production cutover has occurred.

Current step reports and blockers: [execution ledger](checks/autonomous-delivery/progress.md). Each task follows Understand → Implement → Review →
Validate, adding Release/Observe when it changes deployed behavior. Record attempts, issues,
difficulty with rationale, evidence, and next action on every completed step. Implement small
reviewable slices on the integration branch; keep the final main-targeting PR as a draft until
the release gates below pass. The user explicitly authorized rebasing this epic onto the newer main on 2026-11-05; that reconciliation is recorded in the execution ledger. Other local merges or history rewriting still require authorization.

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
| F09 | Connect to the configured Coder instance through OAuth | F01, F02 | Adapt the verified Creative Studio admin pattern; browser consent, owner/origin binding, expiry/refresh/revocation and migration from existing connections pass. Minimize stored credentials and document what unattended operations still require. |
| F10 | Add in-app Codex and Claude account connections | F04, F09, D12 | A native Accounts window handles connect/status/cancel/reconnect/disconnect for each provider through its supported flow; no terminal or callback-URL copy/paste is required. Credentials remain scoped to the intended user and workspace runtime; independent provider acceptance passes. |

F02 is a capability gate, not a production cutover. Build F04 early: shared-session attachment is a
core requirement, not something to discover after building the conversation UI. Use the smallest
prototype before visual polish. F06 cleanup additionally requires the completed delivery evidence
specified by policy; it may be validated with controlled fixtures before production pilot use.
D09 production enablement also depends on F06–F08. D12 packages F04/F05/F06 workspace capabilities.
Update accepted requirements and cross-references when implementation evidence changes this sequence.

## Branch, review, preview, and release strategy

Accepted deployment correction (2026-11-05): use one `hive` Worker with native branch
Previews, following Creative Studio and Top Decor Ledger. Cloudflare Workers Builds
connects the GitHub repo and publishes PR branch commits automatically once its dedicated
build token and trigger are enrolled. Compose auth/jobs within this Worker so Preview
service bindings cannot reach production. Production remains inactive pending reviewed
main artifacts and user-approved cutover. See [environment setup](../deploy/cloudflare/environments.md);
this supersedes the temporary separately named preview/production target layout.

Use one long-lived integration branch for this bounded major project. The current branch is
`codex/delivery-system-design`; it can remain the integration branch rather than creating a new
clone or restarting the task. Preserve the primary checkout and isolate only concurrent work.
Create Conventional Commit slices and obtain review incrementally. If child branches are needed,
use GitHub PRs into the integration branch; local merges/rebases require explicit user authorization.
Keep one draft PR from the integration branch to main while work remains. The authorized 2026-11-05 rebase is published with an explicit lease against the recorded remote epic head; other force pushes remain prohibited.

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

## Account connection refactoring (added 2026-11-05)

F09 and F10 were initially accepted as documentation-only roadmap scope. On November 6,
the user explicitly prioritized implementing F09 after observing the legacy login form.
F09 remains active, with its Preview login checkpoint accepted: real provider consent/code
exchange, concurrent refresh, native Chrome navigation and authenticated Hive reload pass.
Provider consent/code exchange ran on the primary; Browser Testing separately verified the
native link and reloaded an injected Hive application session. This is not a continuously
browser-driven provider sign-in proof. See the [scoped evidence](checks/autonomous-delivery/coder-oauth-live-preview.json)
and [execution ledger](checks/autonomous-delivery/progress.md#2026-11-06-f09-preview-acceptance-and-current-pilot-state).
Independent production client enrollment and offline preparation are ready without production
activation. Dedicated-account provider revocation and same-owner reconnect now pass, including deletion
of both old sessions and unchanged old-cookie API401 after reauthorization.
[Live revocation evidence](checks/autonomous-delivery/coder-oauth-revocation-live-preview.json).
Explicit Settings disconnect now passes the real Browser/app/provider flow: Cancel sends no
mutation, confirmation submits once, all old sessions and the captured access token are
invalidated, and same-owner OAuth restoration creates only a new session. The durable notice
survives cache clearing and the stale-time synthetic focus check; native tab focus is not
claimed. [Disconnect evidence](checks/autonomous-delivery/coder-oauth-disconnect-live.json).
Final production acceptance remains a gate.
F10 base implementation from PR #414 is integrated: Codex and Claude cards use the
existing signed workspace bridge and supported official CLI flows. Focused local
checks pass; final package integration and real provider/browser acceptance remain
open. Account changes cannot mutate credentials while a managed runtime holds
them; completing a turn alone does not close that runtime. Track this limitation
and both account tasks in final epic acceptance.

F09 replaces Hive's normal email/password connection with “Connect to Coder” against the
instance-defined `https://coder.kethalia.com`; no server-URL prompt is introduced. Use the
Creative Studio admin OAuth implementation as the starting reference, adapting its connection
ownership to Hive's per-user authorization. Verify provider availability, registration, scopes,
callback configuration, refresh/revocation and existing-session migration before retiring the
current connection method. Document the least persistent state needed by interactive and
unattended operations. OAuth does not by itself eliminate access/refresh credentials: the
reference encrypts and stores them. Assess alternatives before choosing storage; never claim
that local account metadata and delivery history disappear with the login change.

F10 adds a native Accounts/Connections window within Hive for Codex and Claude, with separate
connection cards and visible status, expiry, cancellation and reconnect behavior. The app may
open the provider's official consent page in another tab and display a device code where
required; the user should not need a terminal, pasted callback URL, or manual runtime-file edits.
Complete sign-in in the intended workspace runtime and preserve its existing user-managed
configuration. Keep application credentials out of browser storage and conversation transcripts.
Codex has a concrete Creative Studio device-code UI reference. Claude requires verification of
its supported browser/device flow before selecting an implementation; do not assume the two
providers offer the same protocol or copy credentials between workspaces.

Validation includes denied/expired/cancelled consent, duplicate or late callbacks, refresh
concurrency, logout/revocation, workspace restart, wrong-owner/build rejection and existing
session/configuration preservation. Assess effects on background jobs and credential rotation
(F07), cutover/session migration (F08), and workspace provisioning (D12).
See the [reference audit](checks/autonomous-delivery/account-connections-roadmap.md).

## Immediate next task

The unnecessary custom publisher and setup-token requests have been removed. The existing
Cloudflare Workers Builds integration remains the single deployment path for the epic branch.
Migration 45 stays immutable; forward migration 46 safely retires its unused schema only when
all publisher tables are empty. The premerge release and migration approval gates now accept
current implementation/preview evidence while preserving pending production verification.

The original isolated 20Gi host held before native execution. The launch-budget
repair passed source checks and immutable image publication; a later isolated
host passed installed package/private-volume/empty-session checks. Its ordinary
two-hour autostop exposed a separate bootstrap-only restart rejection, before
account transfer or model execution. PR #413 repairs that path while preserving
the signed history; review also requires interrupted retirement to resume across
different builds. Both stopped hosts and their evidence remain retained.
See the [original attempt](checks/autonomous-delivery/managed-flow-20g-prelaunch-hold.json)
and [restart record](checks/autonomous-delivery/managed-flow-08cf-restart-20261107.json).

Restart/account/release source is now integrated. The exact combined recovery/account
image passed installed checks and two signed bootstrap-only restarts. Credential transfer
then exposed a valid Coder fsGroup HOME rejected by the account lock, before any cache write
or model start. PR #418 repairs that source; publish and verify its immutable image before
the real manager/child/source/independent acceptance pilot. Browser Testing Phase B is
prepared; live shared-thread acceptance remains pending. [Hold](checks/autonomous-delivery/managed-flow-08cf-auth-lock-hold.json).

PR #412 supplies preview epic integration. PR #415 is integrated after full CI/current
Codex review, with seventeen composed PostgreSQL checks covering connected Builds and
independent production acceptance. PR #417 makes the existing Builds command deployable
only after separate explicit first-cutover/ongoing owner enrollment; no enrollment is active.
Both Preview databases have [migration48](checks/autonomous-delivery/neon-preview-migration48.json).
D10 extends the existing controlled database workflow to this path; its first composed
real-PostgreSQL flow passes with simulated providers, while negative/race tests and integration
remain. GitHub ruleset compatibility and exact protected-target settings also need acceptance;
no repository protection has been changed.

Finish the remaining F07/F08/F10 account-backed parity/recovery gates and release-controller
acceptance. F07 still needs a browser-independent preparation wake; the
[same-Worker durable alarm proposal](checks/autonomous-delivery/durable-wake-plan.md)
is awaiting architecture approval, with no new binding or runtime implemented.
Prepare production bindings, retained identities, explicit production OAuth,
migration compatibility, scheduler handover and rollback as a concrete cutover package for the
user's final approval. Production activation is not authorized. The
[execution ledger](checks/autonomous-delivery/progress.md) distinguishes source implementation,
scoped Preview acceptance and outstanding production milestones.


### Bootstrap acceptance versus epic completion

Each task with production criteria has two explicit milestones: implementation/preview accepted
(premerge) and activated/production verified (postmerge). D09, D10 and D13 must have implementation,
preview pilots and recovery rehearsals accepted before bootstrap merge; their real production pilots
remain pending until afterward. A ready bootstrap PR does not close these tasks or the epic. Show
those pending production criteria in the final PR and Delivery window. This avoids requiring a
production release as a prerequisite to the merge that creates that release. Unexpected production
findings become reviewed follow-up fixes; do not promise that preview proves all live behavior.
