# Autonomous delivery design

Status: implementation contract updated 2026-10-29; architecture decisions below accepted in discussion. This document records the user's
requested product direction; it does not claim that delivery automation is deployed.
Implementation progress is tracked in [the delivery epic](autonomous-delivery-epic.md).

## Outcome and product contract

A user describes a fix, feature, or performance outcome in a visible Codex manager session.
Hive decomposes large requests into epics and concise dependent tasks, delegates engineering
to subagents, obtains review and test evidence, and carries eligible changes through healthy
production. A native Delivery window shows tasks, steps, attempts, reports, and important
notices alongside the manager terminal. Every completed step generates a notification.

The manager owns requirements, decomposition, coordination, and user communication.
Subagents perform bounded research, implementation, review, validation, and release preparation.
The manager handles routine bookkeeping directly. Ambiguity that changes product behavior,
unavailable authority, and exhausted repair budgets become explicit decisions for the user.
No repeated approval is needed for actions already covered by the delivery contract.

A small change may be a standalone task. An epic retains the outcome, exclusions, acceptance
criteria, dependencies, rollout strategy, and integrated production checks. Plan upcoming tasks
in detail and refine later tasks from evidence. An epic is not complete just because its PRs
merged. Required migration cleanup and integrated acceptance checks must be accounted for.
Incomplete features can ship behind disabled flags; activation is a separately verified step.

## Existing foundations and boundaries

- [Agent tools](agent-tools.md) provide owner-authorized workspace inventory, local session
  tracking, and native resume. The local index is bounded and is not a delivery database.
- [Notifications](agent-notifications.md) provide scoped callbacks, BullMQ delivery, push,
  foreground alerts, and terminal routing. Stop means turn completion, not verified success.
- [Window management](window-management.md) supplies native windows inside `/workspaces`.
- [Deployment](deployment.md) defines image promotion, migration jobs, and recovery constraints.
- [Workspace agents](workspace-agents.md) define specialist lifecycle and evidence preservation.

Keep the manager and active repository checkouts in ai-dev-k8s. Browser execution belongs in browser-testing;
live infrastructure operations belong in infrastructure. Only the primary orchestrates
workspaces. Preserve existing template discovery, reuse, handoff, and cleanup requirements.
Do not revive Coder Tasks, agentapi, retired Hive Tasks, or a second task-specific web service.
Use the existing authenticated transport and Hive app with a new durable delivery domain.

Current AGENTS.md reserves merges for the user. The desired end state explicitly includes
automatic GitHub merges and production promotion. Enable that only together with an enforced,
versioned repository delivery policy and a deliberate AGENTS.md update in the release slice.
This design alone does not change current permissions. Keep direct main pushes prohibited.

## Components and ownership

1. **Manager adapter in the software workspace:** attaches a delivery identity to a native
   Codex session; supplies scoped task context; submits structured reports; resumes from
   durable checkpoints. Verify supported native interfaces before choosing a launch/control
   transport. Do not scrape terminal text or inject commands into an active TUI.
2. **Hive delivery controller:** durable state transitions, dependency scheduling, attempt
   leases, evidence validation, retry budgets, policy evaluation, and external action tracking.
   It determines eligibility; a model cannot self-authorize a release.
3. **External executors:** CI, GitHub review/merge integration, specialist validation, and the
   existing release/GitOps path. Each returns independently queryable evidence.
4. **Delivery window:** authenticated read/control surface over the same records. Closing the
   window or losing a browser connection does not stop delivery.
5. **Notification outbox:** records each step completion with its transition and delivers
   alerts through existing push infrastructure.

Neon PostgreSQL is the selected target for authoritative delivery state, subject to runtime
compatibility validation. Cloudflare Workflows coordinates durable execution and Queues delivers
retryable jobs. Existing Redis/BullMQ remains a migration source, not the target architecture. Use an append-only event history with transactional state projections
and an outbox. A worker restart reconciles external operation IDs before retrying effects.
Replace existing background-worker lifecycle assumptions with Cloudflare execution primitives.
Keep domain transitions and external-action idempotency explicit even when Workflows retries steps.

## Domain model

Every record is owner-scoped; repository identity and authorization are checked server-side.
Proposed entities, not migrations already applied:

| Entity | Essential fields |
| --- | --- |
| DeliveryPolicy | Repository, version, enabled mode, checks, review rules, allowed actions, environments, budgets, migration/recovery conditions |
| Epic | Outcome, acceptance criteria, exclusions, dependency plan, activation and integrated verification |
| Task | Optional epic, scope, dependencies, repository, branch, acceptance criteria, risk, manager binding |
| Step | Task, kind, criteria, state, current attempt, required evidence, version |
| Attempt | Agent/session identity, workspace, lease generation, model/effort requested and effective, start/end, usage if available, outcome |
| Evidence | Type, immutable source identity, revision/digest/environment, result, location, producer, validity |
| StepReport | Summary, difficulty and reason, issues/resolutions, attempts, remaining uncertainty, evidence, next action |
| Notice | Severity, decision/blocker/incident, owner, acknowledgement and resolution |
| DeliveryEvent | Unique ID, scope, aggregate version, attempt, timestamp, event type, schema version |
| ExternalAction | Idempotency key, target, request status, remote ID, reconciliation outcome |
| NotificationOutbox | Completion event, recipient, dedupe identity, delivery attempts/status |

Keep repository artifacts in the owning checkout and preserved evidence locations. Database
records reference immutable evidence where possible. Define retention/deletion before release:
retain the audit chain for active deliveries, redact secrets, and do not retain entire native
agent transcripts or hidden reasoning. Unknown token usage/cost remains unknown, not zero.

## Step lifecycle and evidence

Default steps are Understand, Implement, Review, Validate, Release, and Observe. Combine steps
for trivial tasks and add migration/backfill steps where needed; skipped steps require a policy
reason and are displayed as skipped, never as passed.

States: pending, ready, running, waiting_external, blocked, succeeded, failed, canceled.
Pause is an orthogonal control: stop scheduling new effects, preserve progress, and reconcile
in-flight operations. Do not interrupt a migration blindly. Show pause pending until reaching
a safe checkpoint. Resume must reacquire ownership and reconcile, not repeat completed effects.

Only ready steps with satisfied dependencies may acquire a lease. Each result must match the
active attempt and expected aggregate version. Late results from expired leases are retained
as history but cannot advance state. New commits invalidate affected review/check evidence.
A failed step can create a new bounded attempt; previous reports remain immutable. A reopening
creates a visible new transition so progress counts never hide regressions.

Success requires the step's explicit evidence contract. Agent stop, zero exit alone, an elapsed
timeout, a review acknowledgement, and a model's completion claim are not interchangeable with
acceptance. Review and test claims must resolve to results for the correct revision.
One implementation writer per repository by default. Permit independent concurrent tasks only
with clear ownership and managed worktrees; never let multiple agents overwrite shared files.

## Subagent contracts and model routing

Each assignment includes task/step/attempt IDs, acceptance criteria, owned paths, repository
revision, workspace profile, permitted actions, evidence requirements, budget, and stop rules.
Return structured results and concise rationale, not full transcripts. Reviewer context starts
with requirements, the diff, and evidence, independently of the implementer's narrative.
Use existing Codex GitHub review as the PR review mechanism; local reviewers may supplement it.

Route model and reasoning together through an owner-configured, versioned policy:

| Work | Initial allocation |
| --- | --- |
| Inventory and bounded extraction | Available fast model; supported lower effort |
| Routine implementation | Available strong coding model; medium effort |
| Complex debugging, concurrency, migration planning | Strong model; high effort |
| Architecture and unresolved consequential disputes | Strongest appropriate supported configuration; bounded budget |

Inspect actual account/client capabilities and record effective settings. Unsupported settings
must produce a visible capability failure or explicit policy-approved fallback. Escalate on
concrete failure evidence; cap concurrency, attempts, time, and token/cost budgets where exposed.
Do not assume subscription access supplies API credentials or accurate dollar accounting.

Official Codex documentation supports per-subagent model/effort configuration and says that
subagents inherit parent permissions. Custom agent instructions are not a separate security
boundary. Therefore release credentials and policy enforcement cannot be protected merely by
calling an agent a reviewer or release agent. See [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
(accessed 2026-10-28); deployed client compatibility still needs a capability probe.

Do not install locally authored domain-expertise skills or plugins. Use vendor/curated skills
and reviewed repository workflow contracts; do not disguise expert prompts as orchestration.

## Review, merge, and production gates

Verify the real Codex GitHub integration and event shapes before implementing a parser.
Track review requested, running, completed, findings, unavailable, and superseded separately.
Deduplicate fallback `@codex review` requests per revision; do not retry indefinitely. A posted
comment is not completion. Map findings to fixes or evidence-backed dispositions and require
policy-defined resolution. Reviewer outages block the review gate rather than silently waive it.

The gate requires current acceptance evidence, required CI, completed qualifying review,
resolved blocking findings, environment authorization, and satisfied migration/recovery rules.
Use GitHub protections/checks and conditional merge semantics to reject a changed head. Verify
the resulting merge revision and the artifact built from it; PR evidence alone does not prove
an independently built production artifact. Bind releases to full source SHA and image digest.

Release policy lives outside the implementer's unilateral authority. Changes to it require a
separate trusted approval path. Use scoped GitHub/environment credentials; do not give coding
subagents production secrets. Reconcile merge/deployment status after ambiguous network failures.
Keep staged release and observation state distinct from merged or deployed state.
Serialize promotion through observation/recovery with an environment-scoped lease or queue,
including shared targets across repositories. Before rollback, re-check the deployed baseline
and action ownership so an older failed release cannot undo a newer healthy deployment.
Enable production actions only after the Delivery window, per-step notifications, and pause
controls are operational.

Define smoke checks, relevant service metrics, observation windows, and rollback compatibility
per repository. Missing production telemetry is visible, not a fabricated healthy result.
On regression halt further promotions and execute a preauthorized compatible rollback or a
forward repair. Preserve incident evidence and notify the user immediately.

## Database changes

Model schema expansion, compatible application deployment, resumable backfill, integrity
verification, feature activation, and later schema contraction as dependent work. Apply small
transactional schema changes via the controlled migration path; isolate large backfills into
observable jobs with bounded batches, checkpoints, and safe retries. Serialize migration runners.

Test both fresh initialization and upgrade from the previous production schema, mixed-version
compatibility where relevant, interruption recovery, constraints, and locking/runtime impact.
Use sanitized representative data, never copy production data into agent context.

Require explicit compatibility/recovery evidence before destructive contraction. Do not infer
that app rollback reverses a migration. Backups/restoration must account for writes since backup;
restoration is not a default automatic rollback. Follow Hive's forward-only migration runbook.

## Workspace integration

Bake versioned adapter assets and capability diagnostics into the software image/template, and
provide a controlled update/install path for existing persistent homes. Preserve user config,
symlinks, hook trust, existing plugins, authentication, and tracking/notification configuration
locks. Existing sessions require deliberate restart where the native client requires it.
Specialist templates receive only the bounded reporting/assignment capability they need.
No browser installation in ai-dev and no public listener in specialist workspaces.

Hooks report lifecycle facts and wake reconciliation. Explicit structured result submission
reports step evidence. Use scoped delivery credentials distinct from notification callback
credentials: current notification tokens must not acquire task mutation/release authority.
Persist a private local outbox for disconnected reporting, with stable event IDs, schema version,
bounded payloads, retry/backoff, and replay protection. Authenticate the owner/workspace binding
server-side. Hook failure never fabricates success or blocks unrelated interactive CLI use.

Reconnection must distinguish a live session, lost worker, expired lease, and unavailable native
conversation. Durable task state survives loss of session history. The capability spike must
prove that a live TUI and automated continuation can coexist through a supported interface;
otherwise expose the limitation and select a supported adapter before enabling unattended mode.

## Delivery window and notifications

Add Delivery to Hive's native window launcher. Reuse the general workspace, board persistence,
window focus, and mobile layout contracts. Keep UI layout browser-local and owner-scoped while
delivery records are server-side and shared across the user's devices.

The window shows epic/task dependencies, current step and agent, waiting reason, latest activity,
completed/remaining work, production state, and an important-notices queue. Expand a step to view
its attempts, difficulty explanation, issues, resolutions, evidence links, model/effort, elapsed
time, and next action. Provide Open manager, inspect available agent session, pause/resume, and
acknowledge notice. Closing a window never cancels a task; acknowledgements do not resolve blockers.

Emit a persisted notification on every accepted step-completed transition, including re-completion
after an explicit reopening. Use event+recipient identity for dedupe, not task ID. Failed attempts,
blocked work, decisions, and production incidents also produce meaningful notices. Do not issue
periodic unchanged-status alerts. Managed deliveries should avoid duplicate generic Stop alerts
without suppressing unrelated agent sessions or decision alerts.

Push carries a short non-sensitive summary and authenticated deep link; full owner-visible reports
are in the window. Existing lifecycle hooks upload no prose, so detailed reports are a new explicit
payload contract with length limits and redaction. Do not upload prompts/tool arguments/transcripts.
Database completion and its outbox entry are atomic. Transport retries cannot guarantee exactly-once
OS display; guarantee durable history and idempotent processing, expose delivery failures, and respect
OS permissions and existing device preferences. Refreshing or opening another device recovers notices.

Example step report:

> Review completed. Difficulty: moderate; expiry handling needed an extra failure-path check.
> Two findings fixed, no blocking findings remain. Three attempts. Evidence: reviewed revision,
> findings, and regression result. Remaining uncertainty: real browser reconnect pending.
> Next: Browser validation.

## Rollout and success measures

Start disabled/observation-only with no merge or production authority. Then exercise one task's
manager/subagent reporting and UI, enable autonomous reviewed PR delivery, and finally enable
policy-gated production promotion. Exercise a compatible migration and multi-task epic before
broad onboarding. The controller itself cannot self-enable its release policy.

Measure lead time to healthy production, escaped defects, recovery frequency/time, user intervention,
review rework, verification duration, and available agent usage. Difficulty is an explained report,
not a trust score. Pilot success includes interruption recovery and no duplicate external actions.

Required failure scenarios: duplicate/out-of-order events, expired leases, changed PR head, absent
review, conflicting findings, authorization loss, paused in-flight release, controller/workspace
restart, unavailable native session, notification failure, failed migration, and unhealthy production.


## Accepted architecture refinement (2026-10-29)

These decisions refine the initial design. They describe the implementation target, not changes
already applied to existing workspaces or production. The release plan is in the implementation epic.

### One Hive deployment, one Coder instance

Configure the Coder origin server-side; this deployment uses `https://coder.kethalia.com`.
Use a deployment setting such as `CODER_URL`; remove the URL field and user-controlled origin
from login input. Authenticate the user's credentials with the configured Coder service and keep
owner-specific authorization for every operation. Validate existing session origin bindings during
migration. Never forward credentials to an origin supplied in a request. Coder remains the identity
authority; neither Neon nor Cloudflare requires introducing a second user identity system.
Public reachability of Coder does not establish access to workspace-local Codex services: prove that
transport separately. Retain expiry/revocation behavior. SSO support requires its supported flow;
do not assume cookies from Coder can be read by Hive.

### Projects independent of checkouts

Discover accessible GitHub repositories using the user's Coder-connected GitHub identity. Repository
listing is paginated and cached; show pinned/recent projects and searchable accessible repositories.
Use stable provider/repository IDs, not names or local paths, as project identity. Handle rename,
transfer, deletion, and revoked access. Discovery does not clone repositories or create local folders.
Projects retain conversations, delivery history, and evidence even without a checkout.

Prepare a checkout before engineering begins; reuse it during sequential work and an active epic.
Keep a durable project directory with a separately owned removable checkout child. Store native Codex
history outside that removable child and persist project/thread/path/revision associations. Merely
keeping an empty project directory does not preserve session history. Before resuming work, restore
the expected path and reconcile the intended revision with remote changes; never silently resume an
old conversation against unrelated new source state. Concurrent writers require isolated checkouts.
Support an explicit keep-warm preference for frequently used or expensive repositories.

After production verification and the required observation window, request cleanup through the
controller. Verify no active task/process references the checkout, commits are preserved remotely,
required artifacts are durable, and uncommitted/untracked/ignored files have been accounted for.
Hooks request preparation/cleanup; they never authorize deletion on Stop. Report cleanup pending
separately from deployment health. Preserve project metadata, conversation history, and evidence.

This target changes the existing persistent-primary-clone policy. Introduce it only for explicitly
managed projects with updated lifecycle tooling and instructions. Existing primary clones, worktrees,
and repositories.txt remain user-owned until deliberately migrated. Do not delete current clones or
rewrite startup manifests merely because this document describes the new policy.

### Shared conversation and terminal views

Both views attach to one live Codex server/thread on the host. The terminal view retains tmux/CLI;
the Conversation view renders structured thread history and events using maintained shadcn-compatible
components. Do not parse terminal escape sequences or create a second agent for the same conversation.
The native host owns conversation state. Hive stores associations and delivery records, not a competing
conversation engine. Browsing history must not require materializing a checkout; executing code does.

On load, recover history and establish an authenticated persistent event stream. Close the snapshot /
subscription gap using supported cursors, or subscribe and buffer before fetching history and dedupe
by stable identifiers. On reconnect, recover missed state in the background. Validate actual server
semantics; do not assume durable replay cursors exist. Handle thread/item updates and truncation,
duplicate submissions, pending questions/approvals, and interruption across either view. Switching
views must preserve the live thread and must not issue an automatic new turn. The capability prototype
must prove simultaneous CLI and web attachment rather than infer it from shared transcript files.
Treat unavailable capabilities as a blocker to this experience, not a silent two-session fallback.

### Cloudflare application and Neon database

Move Hive's application/control plane off the Kubernetes origin. Keep Coder and its execution
workspaces as the execution layer; migrating the Coder platform itself is outside this epic.

| Responsibility | Target |
| --- | --- |
| Web UI and authenticated APIs | Cloudflare Workers; framework adapter selected by compatibility tests |
| Delivery execution and waits | Cloudflare Workflows with explicit domain gates and idempotent effects |
| Retryable notifications/jobs | Cloudflare Queues, replacing existing BullMQ responsibilities |
| Projects, tasks, steps, notices, auth records | Neon PostgreSQL |
| Worker database connectivity | Hyperdrive to direct Neon endpoint; validate Prisma/driver compatibility |
| Evidence, attachments, exports/backups | R2 with owner-authorized access and retention policy |
| Live stream coordination | Direct authenticated relay; add Durable Objects only where demonstrated necessary |
| Codex, tmux, Git, builds, active checkout | Coder workspace local execution and persistent native session storage |

Neon is chosen over Supabase because this design needs PostgreSQL while retaining Coder identity,
host event streaming, and R2 artifacts. Supabase remains a viable PostgreSQL alternative; its broader
services are not required here. D1 is no longer the selected target. Select Neon region, plan, backup
and availability settings from measured workload requirements; no cost superiority is assumed.
Use schema-only test branches with synthetic data where appropriate. Database migration jobs use a
suitable controlled connection and must be validated independently of request-time pooling. Disable
query-result caching for authority, lease, and delivery-state reads where freshness is required.

The current Cloudflare Worker is only a front door. Extract local process/filesystem operations from
web request handlers into bounded workspace operations; replace background worker assumptions and
validate auth, terminal/audio streams, template operations, and private response caching. Keep native
Codex session storage on its persistent host; R2 archives do not replace the live session database.

References checked during design discussion:
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Coder external authentication](https://github.com/coder/coder/blob/main/docs/admin/external-auth/index.md)
- [Cloudflare Neon integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Supabase architecture](https://supabase.com/docs/guides/getting-started/architecture)

### Object storage decision refinement (2026-10-29)

Neon now offers S3-compatible object storage that branches with database branches.
That can be useful for applications needing matching preview database/file snapshots.
It is not required for Hive's selected database use. Retain R2 for screenshots,
traces, attachments, and delivery evidence whose retention should survive temporary
Neon branch cleanup. Do not introduce a second object store without that concrete
branching requirement. See [Neon Object Storage](https://neon.com/blog/building-neon-object-storage)
and [Cloudflare R2](https://developers.cloudflare.com/r2/).
