# Migration from the delivery epic to feature PRs

Recorded on 9 November 2026. The agreed sequence is documented below.
P01 extraction is active in [PR449](https://github.com/kethalia/hive/pull/449).
Owner acceptance is pending. Subsequent increments follow the sequence below.

Deliver the autonomous delivery roadmap through successive, testable feature PRs,
starting with Cloudflare deployment. Each increment gives the owner a working
preview and a focused acceptance checklist. Keep tightly coupled functionality in
a larger PR when its protocols, persistence and runtime must advance together.

## Reference implementation and scope

The source assessment compares main at `1ace8774118b99b28856347edd51410c4f0a0774`
with the epic implementation at `6d86a0427688f240b1f18c9a34101ee06f06a138`.
The existing integration branch is `codex/delivery-system-design`, tracked by
[PR402](https://github.com/kethalia/hive/pull/402). Preserve that history, its
reviewed corrections and its evidence as the extraction reference.

The original F01–F10 and D01–D13 requirements continue to define feature scope.
The sequence below replaces the single final epic merge with owner-reviewed
increments. Production migration and cutover retain their explicit approval gate.

P01–P11 identify planned increments. Record each actual GitHub PR URL when created.
Extraction builds, migration checks and source review establish the final boundary
for each increment.

## PR sequence and owner acceptance

| ID | Feature PR | Size | Scope and dependencies | Owner acceptance scenario |
| --- | --- | --- | --- | --- |
| P01 | [Cloudflare and Neon deployment foundation](https://github.com/kethalia/hive/pull/449) | Large | Build and serve the existing Hive application through the single `hive` Worker. Include request-scoped database access, required runtime/schema support, authenticated workspace/settings reads, ordinary terminal transport and connected Workers Builds. Establish a reviewed preview configuration for each increment. | Open the preview, authenticate, browse workspaces/settings, reload and use a terminal. Check output, resize, reconnect and clean exit. A branch commit updates the preview to the corresponding source. |
| P02 | Coder OAuth login | Medium | Build on P01 with the configured Coder host, browser consent, credential refresh, revocation, disconnect/reconnect and OAuth-aware terminal credentials. | Sign in through `coder.kethalia.com`, return to the existing Hive identity, reload, use a terminal, then disconnect and reconnect. Validate expiry and concurrent refresh. |
| P03 | Workspace connection bridge and Accounts window | Large | Build on P02 with signed workspace operations, versioned bridge installation, exact workspace/build selection and in-app Codex/Claude connection cards. Separate the account transport from the later managed-task maintenance integration. | Select a workspace, inspect account status, complete each provider's supported sign-in flow and verify saved selection and connection status after reload. |
| P04 | GitHub repositories as projects | Medium | Build on P03 with authenticated discovery, search, pagination and stable repository identity. Separate repository browsing from managed task execution. | Discover and search repositories through Coder-connected GitHub. Select a repository and inspect its identity. Verify repository browsing preserves the existing checkout inventory. |
| P05 | Managed project execution and shared sessions | Extra large | Build on P04 with on-demand checkout preparation, registered sessions, Conversation/Terminal views, guardian authority, manager delegation/progression, source application, acceptance/report persistence, restart/recovery and lifecycle guards. Keep matching host assets, contracts and server checks together. | Submit one small coding task, observe delegation and inspect the same session through both views. Reconnect, exercise a supported interruption/recovery and verify completed results. Check that dirty files and active consumers hold cleanup. |
| P06 | Delivery window and detailed step reports | Medium | Build on P05 with task/step navigation, report history, difficulty/issues/results, owner scheduling controls and links to the correct manager session. | Track the task, open current and historical reports, pause/resume and return to its manager. Verify desktop/mobile layouts and persisted selection. |
| P07 | Background execution and notifications | Large | Build on P06 with durable preparation wakes, agent callbacks, completed-step notification dispatch, credential rotation, template publication/logs and remaining Cloudflare transport parity. Complete the paused step-report wake work within this increment. | Close the browser while work prepares and runs, then return to persisted progress. Receive a notification that opens the correct report. Exercise retries, disabled notifications and the enrolled administrative jobs. |
| P08 | Reviewed delivery through GitHub | Large | Build on P07 with current-revision CI/Codex review evidence, policy eligibility, PR/source publication, controlled merge effects, connected deployment identity and observation. Shared evidence primitives required by P05 travel with that earlier core. | Follow an enrolled change through PR creation, review findings/corrections, passing checks and an isolated deployment verification. Changed source or stale evidence holds advancement. |
| P09 | Epics and coordinated subagents | Large | Build on P08 with decomposition, dependencies, bounded concurrency, writer ownership, integrated source lineage and replanning. | Submit a larger request, inspect concise subtasks and dependencies, observe independent work and validate the integrated result. Exercise a failed dependency and recovery. |
| P10 | Database migrations and backfills | Large | Build on P09 with controlled database jobs, compatible schema changes, backfill dependencies, integrity checks, interruption recovery and activation/contract gates. | Run a compatible migration in the test target, interrupt/recover a backfill and verify data integrity and mixed-version behavior. |
| P11 | Production migration and cutover readiness | Large | Build on P10 with the production-data rehearsal, historical session/key continuity, target privileges, final write boundary, R2/backup restoration, recovery runbook and release package. | Review the migration and recovery rehearsal evidence and production smoke/observation checklist. Owner approval authorizes the subsequent cutover and production verification. |

P05 is the principal coupled feature. Its guardian, checkout, session and manager
protocols share authority and persistence. Keep the implementation coherent while
walking through its acceptance scenarios separately. P06 adds the user-facing
Delivery window to the report data already produced by P05.

## Extraction rules

### Preserve corrected source and runtime compatibility

Assemble each feature from the reviewed final implementation and its required
dependencies. Historical commits and child PRs identify provenance. Include later
fixes to the same behavior when extracting their original feature.

Resolve imports and application entry points for the increment actually being
shipped. Current Cloudflare composition imports project, notification, wake,
release and voice modules. A foundation entry point needs handlers belonging to
P01. Feature flags control runtime activation after the build dependency boundary
has been established.

Current account routes query host state and import managed-account maintenance.
P03 needs a deliberate transport/lifecycle boundary. P05 restores the active-task
maintenance checks as part of the managed runtime integration.

Preserve compatibility with the serving application throughout staged merges.
Validate the existing deployment target alongside Cloudflare where a shared auth,
database or packaging change affects both runtimes.

### Keep schema and grants aligned with each increment

The inspected main has seven migrations and the epic has 54. Every extracted PR
must align its Prisma schema/client, migration dependencies, runtime grants and
queries. The final grant script assumes the final table set exists. Copy it only
with a compatible schema, or extract the corresponding scoped grants with the PR.

Record the exact migration set before P01 extraction. Prefer feature-owned schema
changes where dependencies permit. A shared schema prerequisite may travel in an
earlier increment when its upgrade and older-application behavior are validated.
Resolve this boundary before deploying the extracted application.

Preserve names and checksums of migrations already applied to retained databases.
The original publisher creation and its guarded retirement migrations form one
historical dependency. Keep that history together wherever it has been applied.
Use isolated test data to verify each extracted schema, including fresh install,
upgrade, original-row preservation and the runtime role's actual permissions.

### Move installed artifacts as a reviewed unit

Host changes include the canonical source, native build inputs, profile mirrors,
archives, manifests, installation checks and matching server producer pins. Rebuild
and verify that unit for the feature being extracted. Account and discovery bridge
artifacts follow the same source-to-installed-bytes rule.

Retained host histories have explicit compatibility and recovery requirements.
Include their supported upgrade path in P05 acceptance. Preserve the paused
`codex/delivery-step-durable-wake` work separately until P07 incorporates and
validates it.

### Use the existing deployment integration

Continue using the single `hive` Worker and repository-connected Workers Builds.
The current deployment script pins the epic branch and its OAuth origin. P01 must
establish an explicit per-increment branch/origin/feature configuration that the
existing deployment integration can validate. P02 registers the matching Coder
OAuth callback for its preview.

Give each test deployment matching source, database schema, host/package pins and
enabled capabilities. Verify the provider's actual preview origin and deployed
revision. Preview database/configuration isolation follows the existing cost and
data-access boundaries. Use included capacity and request approval before adding
costs.

## Branch and review workflow

1. Preserve the epic reference and the current paused work. Inventory the source,
   shared dependencies, migrations and acceptance evidence needed by P01.
2. Start P01 from the current released main. Reuse the primary checkout or an
   existing task checkout according to the workspace lifecycle contract.
3. Prepare one complete preview and its acceptance checklist. Obtain independent
   review and current-source Codex review, run required checks and record results.
4. The owner validates and merges the accepted increment through GitHub. Plan the
   next feature against that accepted baseline.
5. Where dependent PRs are prepared in advance, target their predecessor branch
   and state that dependency in the PR. After the predecessor merges, update the
   dependent PR's target and rerun the relevant checks against its actual base.
   Preserve history through the repository's normal push/merge workflow.
6. Keep PR402 as the reference during extraction. Retire its main-targeting merge
   proposal once replacement coverage and preserved evidence are accounted for.
7. After P11 acceptance, present the concrete cutover package for owner approval.
   Complete production migration, activation, smoke checks and observation under
   that approved package. Record the post-cutover results against the epic.

Mark an extracted PR draft while its own implementation or validation remains in
progress. Mark it ready when its increment meets its acceptance gates. Completion
of a feature PR advances that increment's status in the overall roadmap.

## Acceptance record required for every PR

- A short description of the visible behavior and its prerequisite PRs.
- The preview URL, source revision, build/artifact identity, schema version and
  relevant installed host version.
- A focused owner checklist with expected results and test setup.
- Required automated checks and current-source review outcomes.
- A regression check covering previously accepted behavior affected by the PR.
- Any enabled capabilities, migration/upgrade requirements and recovery actions.
- Findings, unresolved issues, acceptance outcome and the owner's merge decision.

Reuse existing evidence for context and regression selection. Verify the extracted
combination through its normal entry points before accepting it. Maintain the
requirements-to-PR mapping and the accepted baseline as extraction proceeds.

## Roadmap coverage

| Existing scope | Planned increment |
| --- | --- |
| F02 Cloudflare/Neon foundation | P01 |
| F01/F09 configured host and Coder OAuth | P02 |
| F10 account connections and bridge packaging | P03, with managed maintenance in P05 |
| F03 repository discovery | P04 |
| F04/F05/F06 shared session and checkout lifecycle | P05, with delivery-bound preservation/cleanup acceptance completed through P08 |
| D01–D04/D07/D08 runtime, persistence and evidence primitives | P05, with GitHub delivery activation in P08 |
| D05 progress and reports UI | P06 |
| D06/F07 notifications and background parity | P07, with transport prerequisites in P01/P03/P05 |
| D09 controlled delivery | P08 |
| D11 epic coordination | P09 |
| D10 database changes | P10 |
| F08 data cutover | P11 |
| D12 workspace setup | Included with the feature that installs each capability |
| D13 pilots, failure drills and onboarding | Per-increment acceptance and the final P11 release package |

## Current planning checkpoint

P01 has an active feature PR and a deployed Cloudflare Preview. Its implementation,
automated checks and hosted acceptance evidence are tracked in
[the P01 acceptance record](checks/cloudflare-foundation/README.md). Owner
acceptance and merge are pending. Historical storage reservation and image-download
issues are assigned to their later increments.

The detailed implementation status and historical evidence remain in the
[execution ledger](https://github.com/kethalia/hive/blob/codex/delivery-system-design/docs/checks/autonomous-delivery/progress.md). The
[epic roadmap](https://github.com/kethalia/hive/blob/codex/delivery-system-design/docs/autonomous-delivery-epic.md) retains the full outcome requirements.
