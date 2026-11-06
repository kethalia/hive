# Autonomous delivery epic execution ledger

Updated: 2026-11-06. Status: implementation in progress, not release-ready.
Branch: `codex/delivery-system-design`.

## Authorization and boundaries

The owner authorized autonomous implementation, trusted subagents, isolated preview validation,
and a completed PR for their merge and production cutover approval. Use free tiers by default; ask before adding costs. The owner separately authorized the
bounded R2 proof and up to one GB if needed; its actual payload is 117 bytes. Do not change production or merge the final PR to main. The owner authorized the November 5 rebase; do not otherwise rewrite history,
or delete unrelated resources. Credentials stay outside source control and evidence.

## Current work

| Task | State | Evidence / next action |
| --- | --- | --- |
| Released baseline | Reconciled with current main | Authorized rebase onto `1ace8774` preserves new dock/config/template features; fresh fetch confirms no newer main. |
| F01 fixed Coder host | Real preview login passed; full expiry/owner scenarios remain | 9cd5005 removes host input and enforces configured origin across login/session/terminal boundaries. Service and web tests pass. 98cf4e9 preserves redirect rejection using Workers-compatible fetch. |
| F02 Cloudflare/Neon | One native Worker and automatic PR builds validated; full parity pending | Only `hive` remains, with the native branch Preview on `hive_native_preview`; both Preview databases now have 44 migrations. OAuth login/navigation and authenticated reload pass; real manager/host and Phase B acceptance remain open. Production stays inactive. |
| F03 project discovery | Real preview discovery/search/enrollment passed | Browser Phase A verifies the connected GitHub account, exact repository, search and stable task-null project enrollment. Opening a project creates no clone or native task. First-task execution remains a separate pilot. |
| F04 same native session | Real-account delegation passed; deployed browser acceptance pending | d10cc02 preserves the actual Sol/low manager and child pilot. Native WS/CLI/history proofs and mounted views pass their bounded tests. Deployed browser attachment and authenticated conversation interaction remain. |
| F05/F06 checkout lifecycle | Local supervisor, renewal and template packaging passed; deployed acceptance pending | bada7bd renews dirty live leases and revokes expired tasks across controller phases. 4d5f703 packages the host in opt-in templates; 5698da6 adds proven pre-execution retry. Production cleanup authority remains disabled. |
| D02/D03 persistence | Foundation, recovery and informational reports validated locally | 7a0b3da adds failed/expired attempts, source revision invalidation and reconciliation. b0e278c serializes manager mutations with registration replacement/revocation. 2e3c10e adds informational reported outcomes separate from verified acceptance, with two additive local migrations and PostgreSQL CI coverage. |
| D04 manager progression | Bounded native/PostgreSQL composition reviewed; installed acceptance pending | 69a868b advances three manager turns and two delegated steps with one held physical writer. All 76 focused native checks pass; expired registration and delayed-response review findings are fixed. Source advancement, runnable recovery, larger epics and interactive CLI coexistence remain gates. |
| D05 Delivery window | Reports, scheduling controls and manager navigation validated locally; deployed acceptance pending | 5f7d3a5: owner-scoped task reads, latest and exact historic report links, native window reuse. 77 focused checks and synthetic desktop/mobile Chrome tests pass. Owner pause/resume and exact manager Conversation/Terminal navigation now pass local checks; integrated deployed acceptance remains. |
| D07/D08 eligibility | Independent semantic acceptance and repair/completion reviewed locally | 9db3f5f includes the repaired current-source SQL fence, bounded same-step repair and controller-derived completion. Parent PostgreSQL/native checks pass; isolated Neon migration preserves all prior rows. Installed real-account completion remains pending. |
| Test workspace | Fresh test and Infrastructure agents never connected; startup inspection pending | Generic operation receipt recovery and owner retry are implemented/reviewed. The `bfd4d88f` immutable image passed smoke and registry publication. Fresh `hive-native-final` has isolated storage but no connected agent; the diagnostic Infrastructure agent also timed out. No auth transfer or enrollment occurred. Global active template is unchanged. [Startup preflight](d11-native-final-readonly-preflight.json). |
| D06 durable notices | Dispatch implemented and local Worker crypto/transport proof passed | 1307b4c bounds durable claims, owner fanout, retry/exhaustion and preserves reports independently of push. Worker jobs have no cron/public endpoint and remain disabled. Actual scheduled delivery to a browser remains. |
| F07 background-service replacement | Partial implementation; local proofs pass | Credential rotation, template publication/logs/notices and task resumption remain default-off. Terminal, clipboard and voice transports have local proofs; account-backed/browser acceptance, 24a454c adds the independently reviewed agent-tools bridge and real tmux environment regression. Account-backed integration and legacy hook parity remain. |
| F09 Coder OAuth | Preview login/refresh/revocation/reconnect accepted; production gates remain | Real Coder consent/code exchange preserves the existing Hive user/session mapping; two concurrent expired-access requests advance one credential version. Chrome native-link navigation and authenticated Hive reload pass separately. Independent production enrollment/helper is ready without activation; explicit disconnect and final production acceptance remain. [Scoped evidence](coder-oauth-live-preview.json). |
| F10 agent account window | Accepted roadmap; implementation deferred | Native Codex/Claude account setup and status in Hive; verify supported provider flows and workspace binding before implementation. |
| Remaining F/D tasks | Pending | Follow docs/autonomous-delivery-epic.md dependencies; no automatic release enabled. |

## Resource and cost record

Neon preview uses a separate Free project (`purple-math-59583745`). Its ordinary application preview remains synthetic. The completed capability, mixed-version and production-capture rehearsal databases were privately backed up and deleted at the owner's request; the current native Preview and local Workerd regression databases remain. Raw production-capture data is never included in reports or public previews. The one retained Hive R2 bucket is still bound to the current preview. See [cleanup receipt](retired-test-database-cleanup.json).
The owner confirmed Cloudflare is already Paid. A bounded preview ran within verified included
usage headroom: 16 scripted requests out of a 20-request budget. No plan upgrades, add-ons, routes
or DNS changes. The isolated Worker remains stored with public serving disabled. Existing paid
plan confirmation is not blanket authorization for additional costs.

## Test workspace policy

The requested software workspace is an epic validation environment under a separate Coder account.
It is not a signed disposable specialist workspace and is not eligible for automatic deletion.
Use two-hour autostop and preserve it for epic validation. Record UUID/owner/template/created_at
from the creation response before use. Do not copy primary owner or Codex credentials into it.

## Step reports

- Baseline alignment: complete, low difficulty. One formatting-only conflict caused by the
  already-released template CI fix. Retained released formatting, ran four tests, integrated
  current main through PR #401 without changing main.
- Test account authentication: complete, low difficulty. Authenticated with supplied credentials
  using isolated private temporary session storage; primary Coder CLI login unchanged.
- Test workspace preparation: complete after the owner reconnected GitHub, moderate difficulty.
  Created and verified the isolated persistent test workspace. Fresh dedicated Codex device authentication succeeded. The initial runtime-directory failure
  was corrected; the real-account manager/child pilot now passes with evidence preservation underway.

## Completion gates

Implementation and preview acceptance precede the final ready PR. Real production activation,
production pilots and observation remain pending until the owner merges and authorizes cutover.
A passing probe or a merged baseline-sync PR does not complete any broader roadmap milestone.

- Shared-session runtime proof: complete for bounded shell-command stimuli, moderate difficulty.
  Parent independently reproduced five reconciled turns and same live thread in CLI plus clients.
  First empty thread requires special handling; real inference, approvals and deployed browser attachment remain unverified.
- Independent eligibility review found arrival-time ordering could accept a delayed old success.
  Added remote update identity and exact producer binding; 25 focused checks pass.
- Epic draft: https://github.com/kethalia/hive/pull/402. Not ready for merge.

- Cloudflare runtime proof: complete for the isolated fixture, moderate difficulty. The first Coder
  request failed because Workers rejects fetch redirect mode `error` before connecting. Manual
  redirect handling plus explicit rejection resolved it; final seven checks passed at e711046.
  Full application compatibility remains a separate gate.
- Session transport: implementation checks pass, high difficulty. Native version compatibility,
  owner/runtime-bound short-lived tickets, replay prevention, reconnect reconciliation and renewable
  read access were exercised. Empty-thread attachment and host supervisor integration remain open.

- Delivery persistence: bounded foundation accepted, high difficulty. Concurrent duplicate writes,
  immutable audit records, atomic outbox rollback, owner isolation, retained legacy records and real
  PostgreSQL restart were checked. Explicit reconciliation and external producer authority remain.
- Browser component validation: accepted for synthetic fixtures, moderate difficulty. Both desktop
  and mobile Chrome checks passed, with preserved screenshots/traces and no page errors. A test
  selector initially used the wrong Terminal button label and was corrected. Newly created Browser
  workspace was stopped/deleted with the installed signed helper; fresh workspace list confirms absence.
- Managed checkout prototype: accepted for local Git fixtures, high difficulty. Independent review
  found ordinary push-upstream metadata broke release. Narrow upstream validation fixed it; 21 tests
  pass. No production cleanup authority or automatic lifecycle hooks are enabled.
- Full schema preview database: ten tracked migrations applied to a new empty hive_app_preview
  database in the existing Free project. Runtime role cannot create schema/roles/databases and has
  no superuser permission. Full app runtime authentication/transaction acceptance remains pending.

- Cloudflare application build: clean committed build accepted for its bounded scope, high difficulty.
  SSR alone did not exercise the database: actual auth execution exposed eager initialization of the
  Node Prisma client inside workerd. Conditional workerd exports fixed it; nine real local-workerd
  auth/database checks pass with the restricted Neon role. Actual app service binding is next.
- Delivery notification claims and notices: bounded database/UI slice passes, moderate difficulty.
  Review caught non-report notices being skipped by an inner join; owner-scoped optional report
  joins now deliver task links. Exhausted-claim cleanup is bounded too. Browser push remains
  unactivated; durable reports and notices remain available independently of notification settings.
- Test workspace: unblocked and healthy after the owner's GitHub reconnect. Created a persistent
  epic validation workspace through the test account, with a recorded identity and two-hour
  autostop. The earlier waiting CLI had exited on a transient Coder gateway error; a fresh request
  confirmed no existing test workspace before creation.
- Preview schema: the additive runtime-recovery migration is now applied only to hive_app_preview
  (eleven migrations). It adds observation identity/version guards and bounded event payloads;
  no production database was migrated.

- Host registration and manager transport: reviewed and committed at b0e278c, high difficulty.
  Parent validation passed 100 focused checks, including 18 actual PostgreSQL tests, plus typecheck.
  Fixed stale revocation authorization under Serializable isolation and exact lost-heartbeat
  acknowledgement recovery. Manager claims cannot supply trusted evidence or effective runtime
  model settings. The route remains disabled until trusted runtime/evidence composition is ready.
- Project opening decision: selecting a repository enrolls its stable identity without cloning or
  starting a native thread. Submitting the first task prepares a verified checkout lease and then
  creates the manager thread. This preserves the existing execution lease boundary; merely browsing
  projects does not create idle clones.

## Immediate implementation sequence

1. Verify a fresh isolated host using the smoke-tested, registry-published `bfd4d88f` image and
   exact owner/build/package identities. Generic operation receipts and explicit owner retry are
   implemented; retain earlier uncertain hosts in quarantine.
2. Run the real manager/child flow through source publication, independent semantic acceptance
   and factual closure against the same native Preview. Do not equate local recovery proofs with
   installed execution acceptance.
3. Run Browser Testing Phase B for shared Conversation/Terminal continuity, durable task status
   and acceptance. The completed OAuth navigation/reload checkpoint is a separate bounded gate.
4. Complete remaining F07/F08 account-backed parity, migration/recovery and release-controller
   acceptance, full CI and independent review. F10 stays deferred.
5. Prepare explicit production OAuth, retained identities, bindings, migration compatibility,
   schedules and rollback as the concrete final cutover package for owner approval. Production
   execution remains disabled; only then complete PR #402 for the owner's merge.

- Project preparation and shared-session views: committed at 7635164, high difficulty. 69 focused
  project/UI/scheduling checks, host/package tests and typecheck pass. Accepted prompts are encrypted,
  durable claims survive browser loss, and running tasks recover host registration without prompt
  resubmission. A thirty-minute no-progress deadline bounds preparation. Explicit safe blocked retry,
  long-task lease renewal and real browser/account acceptance remain under implementation.
- GitHub evidence: 44 focused checks pass, including twelve actual PostgreSQL cases. Independent
  review caught reused policy labels retaining old passes; the full canonical policy digest now
  participates in evidence authority and invalidation. Snapshot replay cannot accept missing evidence.
- Preview schema: all eighteen committed migrations through preparation progress applied to the
  isolated Neon application database and local upgrade fixture. Runtime CRUD permission was granted
  only for the new project_task_intents table. Production data and schema remain unchanged.

- Template-installed host: implemented at 4d5f703, high difficulty. All 83 template checks
  and three package checks passed on staged sources; Infrastructure Terraform validation passed.
  Inactive Coder version hive-epic-5698da6 (267d9346-310b-4364-b4b8-733b6bcd602b) imported
  successfully; the active template remains 1b6dbdb0-69d0-4213-9d53-b8a4f33e8c30.
- Safe preparation retry: implemented at 5698da6. Durable retry receipts preserve the original
  prompt identity. Actual Codex 0.165 cannot expose complete history for some empty loaded threads;
  these remain blocked rather than treating unavailable history as proof of no execution.
- Credential metadata correction: an overly broad workspace metadata tool result exposed an
  existing interpolated GitHub token in this session. No token value is saved in this repository.
  Removed provider-token interpolation from all new template startup scripts; the existing
  runtime external-auth helper still authenticates repository bootstrap. Rotation of the exposed
  Coder/GitHub authorization was requested. Existing active templates were not changed.

### Mounted host bootstrap and native isolation checkpoint

- **Implement / Validate: completed for template installation; high difficulty.** The live
  persistent test workspace exposed two gaps after local tests: Coder's shell argument limit
  rejected the inline archive, and the service account rejected a ConfigMap creation. The final
  implementation uses compressed, byte-bounded public pod metadata projected read-only through
  the Downward API. All 86 template checks and specialist Terraform validation pass. The exact
  `06e00da` inactive template now starts a host, returns HTTP 200, and reuses it on repeated
  installation. No cluster RBAC or global active template was changed. Evidence:
  [template installation](workspace-template-installation.md) and
  [live result](test-workspace-host-installation.json).
- **Review / Validate: completed for the isolated native fixture; high difficulty.** Parent
  independently reran the pinned runtime proof successfully. Root, resume and child commands
  cannot access protected synthetic files; the profile-only negative control demonstrates why
  the legacy override fence is also required. Commit `0bc7894` preserves both passing and failing
  evidence. Installed launcher integration is underway; background-writer quiescence remains
  unproven and must keep delivery writer holds. No fixture result enables production execution.
- **CI:** the available CI checks passed at `68b4aaf` (GitHub reports no required checks); new template checkpoints are pushed for CI.
  The main-targeting epic PR remains a draft, with account-backed browser/session tests and the
  remaining delivery and Cloudflare compatibility work still required.

- **GitHub connection recheck:** the installed helper successfully read the first 100 accessible
  repositories using the test workspace's own agent-scoped external authentication; Hive was
  included and the response reported another page. This verifies the reconnect and installed
  helper, not complete pagination or the web application path. No repository was cloned by
  this read. [Sanitized result](test-workspace-github-discovery.json).

### Installed runtime and live evidence checkpoint

- **Implement / Validate: installed isolated host; high difficulty.** Commit `2e7aa31` also
  removes duplicate uncompressed archives to fit Coder's one-MiB template upload limit. Inactive
  version `4bec462b-de81-4a8a-9558-fec3182e1ccc` runs in the recorded persistent test workspace;
  health returns 200, native isolation is enabled and manager execution remains disabled. The
  global active template is unchanged. [Installed result](test-workspace-isolated-host.json).
- **Validate: native writer drain remains blocked; high difficulty.** `faa9530` proves whole PID
  namespace termination stops detached synthetic writers, including writers with unlinked files.
  The complete native runtime does not yet pass in that namespace arrangement. Native turn
  completion and empty terminal inventories are insufficient to release writer ownership.
  [Evidence and limits](native-writer-quiescence.md).
- **Validate: signed GitHub source transport; high difficulty.** `60f74a8` passed focused
  source, collector, helper and composed PostgreSQL/local-workerd R2 checks. This exercises the
  canonical modules; it does not establish an activated installed-host source collector.
  [Evidence](github-transport.md).
- **Validate: account-backed pilot stopped before inference; high difficulty.** Device login
  succeeded in the test runtime's own Codex home. Startup then rejected command execution because
  vendor-created runtime aliases conflicted with protected credential paths. A real-home
  reproduction identified the conflict; the proposed private temporary-directory fix is under
  test. No model task, child delegation or production work was claimed as successful.
- **Validate: live R2 retention and integrity passed; low difficulty.** A private task-created
  bucket stores 117 bytes. Full readback matches its recorded SHA-256; identical overwrite,
  changed overwrite and deletion all failed under the thirty-minute lock. Cleanup completed after independently verifying the expired rule,
  exact object and bucket identity; final storage is zero. [Live evidence](r2-preview/result.json).

- **Validate: actual-account delegation passed; high difficulty.** The corrected `576b889`
  host package is installed and independently rechecked in the test workspace. Installed command
  readiness and credential-denial controls pass. A bounded real-account pilot then completed in
  about 35 seconds with exactly one manager and one child using the requested/effective
  `gpt-6.1-sol` at low reasoning. The child wrote a two-file fixture and ran six tests; the
  manager independently reran them, and the copied fixture passes in the primary workspace.
  This is runtime/delegation evidence, not activated delivery, background-writer quiescence or
  production acceptance. A missing `rg` command was handled by the child using `ls`; `7a4ea08` fixes its pinned
  PATH integration with local validation; that newer package is not yet installed in the test workspace. Initial startup/test failures are preserved.
- **Implement / Review: bounded retry journal retirement; moderate difficulty.** `a4fa338`
  prevents the private GitHub spool from permanently filling after 32 requests. Fifteen tests
  cover safe expiry retirement and exact pending retry preservation. Independent review found
  validation-ordering and nonregular-file handling gaps; both were corrected before commit.
  [Evidence](github-journal-retirement.md).

- **Review / Validate: manager policy integration passed; high difficulty.** Parent reran all
  92 focused checks, including twelve real PostgreSQL policy tests. Current PR identity,
  complete requirements and source provenance are rechecked in the result transaction; a
  policy change or revoked source cannot leave a successful report. `eff1727` includes these
  regressions in PostgreSQL CI. [Evidence](manager-policy.md).
- **Validate: actual Cloudflare callback path exposed a redirect; moderate difficulty.**
  The local deployed-framework proof reached the configured issuer, then received HTTP 307
  from browser middleware before native signature verification. The first failure is preserved.
  The shared exact callback exception is being integrated into both middleware and the outer
  Worker; no failed candidate was deployed.

- **Validate / Cleanup: live R2 proof complete; moderate difficulty.** Integrity and locked
  mutation rejection passed with 117 bytes. R2 still rejected deletion after the Date expiry;
  fresh checks found no drift, so the primary removed only the authorized expired test rule.
  The object and empty task-created bucket were then deleted; a fresh inventory confirms
  absence and the original five unrelated buckets remain. Automatic Date-expiry deletion is
  unverified. Thirty conservative reservations plus one earlier list read stayed within the
  operating budget. [Cleanup and ledger](r2-preview/cleanup.json).

- **Implement / Review / Validate: informational reports passed; moderate difficulty.**
  `2e3c10e` lets the manager report understanding, difficulty and issues without claiming
  independent verification. Peer review found no blocking issue; parent reran29 PostgreSQL/UI
  checks,15 host/native checks and5 package checks. Both new migrations were tested locally
  (fresh21 and upgrade19→21), not applied to Neon. Existing writer holds remain.
  [Evidence](informational-report-local/parent-review.json).
- **Validate: Cloudflare browser login exposed an unresolved failure; moderate difficulty.**
  Remote app/auth bytes match the prepared106721d candidate. The browser loaded the fixed-host
  form but did not send a login POST;21 requests and7 blocked routes were recorded. The
  dedicated account still has zero session/token rows. Both Worker public URLs were disabled
  immediately after the run. Preserve this first failure while diagnosing hydration and harness
  behavior; no successful login/layout/logout claim yet. [Evidence](cloudflare-browser/live-result.json).
- **CI: formatting corrected; low difficulty.** The last pushed check found JSON array
  formatting in native writer evidence. `b5215c1` applies the repository formatter; the full
  local formatting check passes. Fresh CI is pending on the updated epic branch.
- **Cleanup investigation: no user action required.** The owner does not have node-log access
  information. Continue diagnosis internally; preserve task source when drain cannot be proved.
  No speculative privileged workspace or server-policy change is authorized by that exchange.

- **Validate: real Cloudflare browser follow-up passed; moderate difficulty.** A local
  React/Chrome fixture reproduced a form-hydration race. `13624f5` waits for the handler before
  filling/clicking and precharges the first run's21 requests. The live follow-up used33 more
  (54 total), performed one login, verified secure host-only HttpOnly session cookies,
  desktop/mobile horizontal overflow, browser-initiated API logout and old-cookie401. Neon
  confirms zero sessions and one identified managed Coder key retained for normal rotation.
  Both public URLs are disabled. Normal Settings-screen logout, fonts/full visual parity,
  discovery, native-session interaction and other baseline features remain unverified.
  [Evidence](cloudflare-browser/live-hydration-followup.json).

- **Implement / Validate: portable Settings and login readiness; moderate difficulty.**
  `605b405` replaces the Settings window's server-action read with an authenticated typed GET,
  keeping the existing action and Sign out behavior. Parent reran46 owner/auth/middleware/UI
  checks. Login controls now stay disabled through SSR and initial hydration; five focused
  tests include actual render-to-string/hydration, pending submission and retry behavior.
  These changes are local; the deployed106721d preview has not been replaced with them.
  [Settings evidence](settings-window-local.json).
- **Validate / Cleanup: browser proof preserved; low difficulty.** The primary verified no
  task processes remained, completed the signed disposable receipt, stopped the matching
  workspace and requested deletion. A fresh Coder inventory confirms absence; the primary
  and unrelated workspaces remain. [Cleanup evidence](cloudflare-browser/cleanup.json).
- **Design: same-manager step progression; high difficulty.** `d72c92a` separates the
  logical step cursor from held checkout ownership and requires completed root-turn boundaries.
  A root manager can accept its completed child's result; pending observation transport is an
  ordering problem, not a general self-turn deadlock. Server implementation and a real native
  protocol fixture are next; neither child completion nor a logical cursor releases the writer.

- **Validate: native turn boundaries reproduced; high difficulty.** Parent independently
  reran14 actual Codex0.165 checks with a local canned provider. The same root thread/runtime
  continues across turns, but completed root history can receive delayed child facts and
  concurrent turn starts become inputs to the active turn. The host must own admission,
  reconcile bounded history and drain its handlers; native busy rejection is not a lock.
  No account inference or production execution. [Evidence](native-manager-turn-boundary-parent.json).
- **Validate: software-only process drain candidate passed; high difficulty.** Four synthetic
  subreaper cases passed in both specialist and primary runs, including detached/unlinked-file
  writers, nested supervision, clone-signal accounting and a supervisor-crash negative. An
  unrelated writer survived each scoped drain. Actual native startup, command-denial checks,
  drain and history resume also passed using one local canned response. A separate startup
  timeout is retained; the diagnostic pass used an eight-second readiness bound and does not
  establish the lost failure's exact cause. CLI processes, shared-project admission and trusted
  receipt integration remain open. No server/node policy was changed, and all production
  writer holds remain. [Recommendation](cleanup-capability-next-step.md).
- **Validate: built application authentication passed again.** The committed Settings/login
  checkpoint passes Node/standalone and Cloudflare builds, root/recursive typechecks, and23
  actual local workerd/auth/isolated-Neon checks. It has not replaced the closed106721d cloud
  preview. [Evidence](settings-login-build.json).

- **Implement / Validate / Review: server step progression completed; high difficulty.**
  `9f6d422` adds an explicitly opted-in logical cursor while retaining the original physical
  checkout writer. Signed completed-root boundaries are single-use and scoped to the current
  task, attempt, source and lifetime. The delivery suite passes222 tests (two unrelated opt-in
  proofs skipped); fresh22-migration and21→22 upgrade checks preserve prior data. Parent
  independently reran33 focused PostgreSQL checks; independent review found no blocker.
  Host integration is in progress. Historical retries remain non-runnable acknowledgements,
  and no cleanup or production authority is enabled. [Evidence](manager-progression-server.md).
- **Design: process ownership and source publication boundaries documented.** The
  [guardian plan](native-guardian-design.md) includes CLI/terminal descendants and defers
  elective drain while another admitted project is active or uncertain. The
  [source publication plan](source-advance-design.md) separates immutable attempt input
  revisions from broker-verified output commits. Both need implementation and composed
  runtime acceptance; neither document changes installed permissions or remote resources.

- **Implement / Validate / Review: owner scheduling controls completed locally; moderate difficulty.**
  The Delivery window can request pause or resume through an authenticated, same-origin JSON
  endpoint. It distinguishes requested pause from confirmed stopped scheduling, preserves the
  exact request after a lost response, and reloads current state after historical acknowledgements.
  Fifty-three API/DOM/proxy tests and nineteen PostgreSQL tests pass, including cross-owner
  rejection, competing writes and replay after resume. Typecheck and independent review pass.
  This control neither kills processes nor clears writer/evidence/release holds. Deployed
  browser acceptance remains. [Evidence](pause-control-local.json).

- **Implement / Validate / Review: exact manager navigation completed locally; moderate difficulty.**
  Tasks expose only their owner-scoped project/workspace/conversation identity. Opening the
  manager subscribes to that recorded native thread; both views reject a different workspace
  or replacement thread on initial grant and renewal. Terminal opens only on request and stays
  mounted across view/pane visibility switches. Independent review found transient task polling
  failures unmounted a healthy terminal; corrected to retain the same view across retryable
  failures while clearing it on access denial. Thirty-one UI/connection and ten PostgreSQL
  checks pass, plus typecheck and independent review. Deployed browser/host acceptance remains.
  [Evidence](manager-navigation-local.json).

- **Implement / Validate / Review: source publisher foundation committed; high difficulty.**
  `753ca56` captures bounded raw source bytes, creates deterministic Git objects and journals
  create-only branch/draft-PR publication with ambiguous-response recovery. Independent review
  and both agent/parent 19-test runs pass; the clean template export passes all 87 checks.
  The provider is simulated, source acceptance authority is disabled, and the installed runtime
  does not import the scaffold files. Live transport, protected Git metadata and the database
  output-revision contract remain. [Evidence](source-broker-local/parent-review.json).
- **Implement / Validate / Review: native guardian foundation committed; high difficulty.**
  `eabe291` pins the executable set, owns descendant reaping and closes admission before a
  bounded whole-tree drain. Agent and parent each pass 19 synthetic tests and actual native
  startup, credential-denial, drain and persisted-thread resume with a local canned provider.
  The clean generated scaffold passes 35 packaging/guardian checks. The earlier readiness
  failure is preserved without attributing a cause. Source copies do not install the guardian;
  durable controller, shared-project/CLI/PTY integration and server authority remain.
  [Evidence](guardian-foundation/parent-review.json).
- **Review: host progression admission gaps found; high difficulty.** The parent reproduced
  three root turns and two delegated steps against actual native Codex and PostgreSQL without
  releasing the physical writer, and 66 focused native/runtime checks pass. Independent review
  then reproduced registration expiry before continuation and during a claim HTTP response.
  These must be fixed and revalidated before the host slice is accepted; successful simulated
  progression alone does not establish current execution authorization.

- **Implement / Validate / Review: bounded host progression committed; high difficulty.**
  `69a868b` closes both expiry findings and advances the canonical native manager across three
  root turns/two child steps using actual PostgreSQL. Parent passes all76 runtime checks and
  repeats the native/PG proof with source stability checked through shutdown. The schema23
  fixture exercises base-task compatibility only; simulated model/check evidence is explicit.
  Clean packaging passes87 template and4 package tests. Installed execution, advanced source,
  recovery, large epics and multi-project/CLI coexistence remain. [Evidence](manager-progression-local/host-parent-review.json).
- **Build / Validate: guardian artifact pipeline accepted; moderate difficulty.**
  `e53f561` builds and tests the exact Linux ELF in GitHub Actions, records source/builder/recipe
  identity and supports explicit inclusion in a pinned private host package without workspace
  compilation. Parent and independent build/installer checks pass. The first artifact job passes;
  overall CI separately exposed a terminal-helper lifetime failure under its full runtime suite,
  which is being investigated without weakening the assertion. No artifact has been installed.
  [CI artifact metadata](guardian-build-ci.json).
- **Validate: template comparison works in actual local workerd; low difficulty.**
  `a03f497` matches all five generated template archives, detects changed bytes and rejects
  malformed/unknown inputs. No cloud requests; authenticated Coder download and deployed UI
  acceptance remain. [Evidence](template-comparison-workerd.json).

- Guardian worker boundary: independently reviewed local checkpoint accepted, high difficulty.
  The exact pinned worker receives a private inherited channel; task admissions and a durable
  closed barrier precede whole-tree drain. Actual tmux and PTY descendants are included; active
  work blocks planned drain. Parent27 checks and clean-export87 template/32 package checks pass.
  These receipts are not cleanup authority. Installed startup attestation and independent server
  stop decisions remain. General CI repeated a terminal-helper fixture failure on Ubuntu26.04;
  the fixture now uses pinned Python to avoid provider-dependent coreutils dispatch, retaining
  the unchanged100ms assertion and sanitized diagnostics. CI confirmation is pending.

- Accepted source revisions: reviewed internal server slice complete, high difficulty. Immutable
  attempt inputs and accepted outputs now form an append-only source chain under one physical
  writer. Two implementations plus final validation converge without reopening completed work;
  prior-head quality evidence is invalidated, while completed external actions require a durable
  reconciliation pause. Parent38 PostgreSQL checks, producer258 delivery checks and separate
  Astra review pass. Fresh23/copy-upgrade22→23 preserves all prior data and150 writer anchors.
  The real broker, scoped producer transport and installed current-source readback remain gates;
  no remote schema was changed. The exact CI-built guardian ELF also passed22 parent checks.

- Guarded host and installer composition: reviewed local checkpoint accepted, high difficulty.
  Preparation admission now precedes Git helpers; late replies cannot reopen closed input.
  Fixed outer/worker startup uses a private nonce/config/package-bound handshake and verifies
  exact kernel process identity plus listener ownership. Parent112 actual runtime checks,12
  installer checks and clean-export87 template/4 package/12 installer checks pass. Separate
  actual fixed installer private-home proof remains in progress. Installed task preparation
  and drain are deliberately denied until independent server admission/barrier authority lands.
  CI, image builds and native-guardian artifact build are all green at c63506e, including both
  CI fixture portability corrections and the schema23 source tests.

- Fixed installer end-to-end proof: accepted locally, moderate difficulty. The real Python
  installer, packaged outer, CI-built guardian and fixed worker pass exact listener readiness
  and idempotent recovery after the installer exits. Wrong nonce/config/package/process
  identities and lost-ready replies cannot start another lifetime. Parent independently
  reproduced the4.23-second pass; all fixture processes are gone and primary paths unchanged.
  An unprivileged private-home namespace supplies fixture-only UID mapping for the root-owned
  Node check; no host-root privilege, account inference or cloud operation was used. The signed
  task request correctly remains blocked before Git pending independent server admission.

- Protected source broker: independently reviewed inert checkpoint accepted, high difficulty.
  Server-owned policy seals explicit raw bytes and deterministic commits; exact grant renewal
  and metadata checks precede bounded GitHub effects. Review caught and fixed a credential
  account-switch gap and distinguished attempt from physical checkout lease generations.
  Parent40 Python tests, independent worker7 tests and clean-export89 template/4 package tests
  pass. The actual private FD3 worker preserves prepared/published operations after disconnect;
  synthetic HTTP remains explicit. Fixed JS signing/deadline composition, real guardian metadata
  authority, broader repository scale and an installed provider pilot remain; no live writes or
  activation. CI/images/native guardian builds are green at the preceding92f7b25 checkpoint.

- Read-only Git metadata: reviewed protection checkpoint accepted, high difficulty.
  Native root, child, CLI and resumed thread keep working-tree writes while complete Git
  metadata and the project parent stay read-only. FD-pinned mounts survive pathname swaps;
  host atomic ref updates remain visible. Parent13 actual cases and clean-export89 template/
  4 package/30 helper checks pass; producer sequential native57 passes. A real readiness cwd
  incompatibility was fixed. Parallel startup timeouts also affect legacy mode and remain
  unresolved with failures preserved; startup diagnosis and installed independent metadata
  authority are still pilot gates. No activation, cleanup authority or external effects added.

- Broker scale/shutdown follow-up: reviewed, moderate difficulty. A small change in
  a large repository now reuses unchanged Git trees instead of uploading every directory;
  insufficient provider budget rejects before effects. Production Git children remain in the
  worker's process group so timeout cleanup can cover them. Parent and independent43-test
  runs pass; the JS publisher still must prove group absence before releasing its lock.

- Native startup deadline: reviewed and independently reproduced, high difficulty.
  Parallel startup exposed slow filesystem waits close to the previous readiness limit.
  A single-child monotonic20-second deadline now preserves cancellation, revocation, exact
  identity and fail-closed cleanup; it does not claim to bound uninterruptible kernel IO.
  Parent9 focused checks,57 actual parallel runtime checks and20 clean-export packaging
  checks pass. Diagnostic failures remain recorded. Installed account validation remains.

- Independent host authority and source transport: reviewed local checkpoint, high difficulty.
  Schema24 persists staged host/project admissions and refuses revoked producers, including
  replay and second-project finalization. Signed source grants bind exact checkout, attempt,
  sealed bytes and provider readbacks; retained R2 proofs do not authorize execution. Parent13
  guardian and23 transport checks pass; copied23→24 upgrade preserves all26 legacy tables.
  Clean-export typecheck passes. Broader PostgreSQL run183/184 exposed an existing concurrent
  task-enqueue race; evidence retained and immediate fix in progress. No remote migration.

- Task submission race: fixed and independently reviewed, moderate difficulty. PostgreSQL
  now deduplicates concurrent inserts before exact owner/request validation. Sixteen concurrent
  requests converge; foreign-owner task-ID collisions reject without changing retained data.
  Parent9 focused and185 clean-export database checks pass, with typecheck and separate review.
  Previous failing evidence remains. CI/images/guardian were green at fe396ff.

- Fixed host publisher: reviewed and packaged inertly, high difficulty. The private helper
  now journals exact signed requests before transmission and checks independent metadata/grant
  authority around publication. Review fixed a post-reap process-group signaling risk; unknown
  remaining descendants retain the lock for outer recovery. Parent15 runtime/3 cross-server
  protocol checks and35 clean-export packaging/runtime checks pass. Installed composition
  and live provider validation remain; no publication flag was enabled.

- Accepted-source readback: reviewed local server checkpoint, moderate difficulty. Fresh
  host authentication and current guardian authority return exact historical/current source
  facts after the publication grant expires, without writes or new execution permission.
  Parent10 clean-export database/route checks and typecheck pass; producer6 checks include
  a real61-second wait. Host client, protected apply and installed recovery still follow.

- Signed host bootstrap service: reviewed local checkpoint, high difficulty. Owner-app
  nonce challenge and one-use enrollment bind the approved package, exact lifetime and
  server-derived configuration. Signed frame and issuer-grant expiry are rechecked before
  commit; observed SQL-delay/abort tests prove rollback. Parent11 checks and clean-export
  typecheck pass. Parallel test-fixture interference was fixed without weakening assertions;
  its original failure remains. Actual installed outer/worker composition remains next.
  CI, image builds and native-guardian builds are green at3ec009f.

- Guardian CI fixture correction: completed, low difficulty. The new service suite rejected
  CI's loopback hostname `localhost` before running. It now accepts both loopback names while
  retaining the exact isolated test-database restriction. Parent6 checks pass using CI's
  hostname. The original CI result was190 passed/one skipped plus this failed suite; application,
  image and native-guardian builds passed. No production authorization rule changed.

- Protected accepted-source application and packaging: reviewed local checkpoint, high difficulty.
  Parent56 Python checks plus the1,977-file/297-directory scale case pass; dirty, staged,
  ignored and untracked work is preserved. The separate factual state client passes11 runtime
  and one server-protocol check. Parent clean-export validation passes24 archive/template,
  33 application/protocol and52 compiled behavioral checks plus typecheck. Producer evidence
  additionally exercises three actual native namespace cases and the fixed installer with
  the reviewed guardian binary. The assembled upcoming guardian package fits151,578 gzip
  bytes and949,760 template bytes without raising either deployment limit. Node and Workers
  now use the same verified template archive; source and protected metadata changes remain
  inert until the independent application reservation/input barrier is integrated.
  Evidence: [application](accepted-source-application.md), [packaging](template-artifact-packaging.md).
  CI, images and native guardian are green at89531e5; this checkpoint awaits its own CI.

- Installed guardian authentication and queued preparation: reviewed assembled checkpoint,
  high difficulty. The fixed outer and worker connect owner-app identity/bootstrap to the
  signed server service. Durable task preparation waits for approved enrollment; existing
  open retries cannot extend or restore expired/revoked authority. Parent45 runtime plus11
  PostgreSQL/owner-transport checks,12 service checks and12 task tests pass. The clean assembled
  package passes198 database tests (one separate opt-in proof skipped),14 package tests,
  52 compiled behavioral checks, the actual fixed installer proof and typecheck. Failed
  setup cases are retained. Default flags stay off; real native producer/source composition,
  application barriers and cleanup authorization remain gates. Evidence:
  [controller checkpoint](guardian-controller.md), [parent assembly](guardian-controller-local/assembled-parent.json).

- Installed callback transport: reviewed implementation checkpoint, moderate difficulty. The
  Cloudflare private gate and Next middleware now admit only nine exact, explicitly enabled
  non-browser host callback routes to their existing signature/replay checks. Query, encoded,
  browser, oversized and neighboring requests remain rejected. Parent and independent review
  each pass38 focused checks; typecheck passes. The local workerd harness now covers both
  disabled-route privacy and enabled malformed-envelope rejection without enrolling a host or
  using remote R2. Actual workerd execution follows this commit; no deployed flag changed.
  CI for a1b8b06 passed197 database checks but failed the installed fixture shutdown; that
  separate failure is under investigation, with image/native-guardian builds successful.

- Preview schema reconciliation: completed, moderate difficulty. The actual Cloudflare build
  passed, then workerd exposed the isolated preview's older19-migration schema (P2022).
  The failed proof is retained. The existing migration runner applied the five already reviewed
  committed migrations through24 using the direct preview owner connection. Before/after
  checks preserve all existing history/checksums and data counts. The restricted runtime role
  received SELECT/INSERT/UPDATE on six new tables, with no DELETE or DDL grant. No production
  database or deployment changed. The next workerd proof uses this matching schema.
  Evidence: [migration](neon-source-guardian-migration.json).

- Installed guardian CI fixture: corrected and reviewed, moderate difficulty. A cache-like
  Node executable reproduced the guardian's executable-pin rejection. The fixture now runs
  under an owned, readonly copy of the same Node binary, keeping outer/worker version and
  inode agreement and leaving production pin rules intact. It also preserves the original
  failure alongside shutdown uncertainty. Official CI-version Node22 and local Node24 pass;
  parent independently passes the actual installed test on localhost. Original hosted file
  mode was not recorded, so the reproduction is not proof of its exact original permissions.
  Evidence: [CI fixture](guardian-controller-local/ci-installed-node.json).

- Cloudflare host callback compatibility: actual local workerd checkpoint passed, moderate
  difficulty. The committed05721d4 app build passes both enabled and default-disabled
  configurations against isolated Neon24. Nine enabled exact routes return invalid-envelope
  errors; neighboring/query variants stay private, while all nine disabled routes stay private.
  Forged registration/unknown heartbeat are rejected; auth, task reads, ownership, logout,
  expired sessions, serializable transactions and rollback pass in both runs. The second
  failure exposed a missing pre-existing manager-binding table grant; its exact runtime grant
  is corrected and both failures remain. This proves transport/runtime compatibility, not
  successful host enrollment, real source publication or production deployment.
  Evidence: [enabled callbacks](cloudflare-auth-delivery-callbacks.json),
  [disabled callbacks and auth](cloudflare-auth-app.json).

- Source progression and application reservation: reviewed assembled checkpoint, high
  difficulty. Attempts retain their original input identity while completed evidence can
  reference accepted output. Persisted application reservations block new execution until
  that output is acknowledged as applied, while allowing exact completion/failure and factual
  evidence paths. Timeouts retain the pending operation; lost commit acknowledgements recover
  by fresh verification without rewriting receipts. Parent clean-export validation passes207
  PostgreSQL checks (one opt-in skipped),69 source runtime checks,120 compiled behavioral
  checks, cross-server collector protocol, typecheck and the actual fixed installer. The
  schema24→25 rehearsal preserves every prior table hash and migration checksum. A compiled
  test-harness assertion was corrected; the failed log remains. Signed service application
  actions and installed controller/terminal input barriers remain separate integration work.
  No runtime flag or production deployment changed. Evidence:
  [application](guardian-source-application.md),
  [assembled validation](manager-source-local/assembled-parent.json).

- Portable workspace action transport: reviewed implementation checkpoint, moderate difficulty.
  A build-derived allowlist admits eight reviewed workspace HTTP actions and four read-only
  discovery resources through the Cloudflare compatibility gate. Existing authentication,
  argument and lifecycle ownership checks remain. Independent review corrected headerless
  form bypass, the pinned framework's42-character IDs and premature build-lock release;
  generated action mappings are now covered by readiness. Actual workerd and account-backed
  lifecycle/browser validation follow. No workspace was mutated by this implementation.
  Details: [portable actions](cloudflare-portable-actions.md).

- Credential rotation scheduling: reviewed implementation checkpoint, high difficulty. The
  auth Worker now has a disabled, bounded scheduler with persistent leases, credential-version
  reservations and an expiry-notice outbox. Ambiguous provider outcomes retain a hold rather
  than minting again after timeout. Parent clean-export validation passes191 auth tests and22
  targeted tests, including11 real PostgreSQL cases; typecheck and five local workerd checks
  pass. Schema25→26 rehearsal preserves all32 prior table hashes. Workerd uses explicit store
  and provider doubles; real provider rotation, operator reconciliation, Node scheduler
  cutover and cron activation remain gates. No cloud resource or credential was changed.
  Evidence: [rotation design](token-rotation-scheduling.md),
  [parent validation](token-rotation-local/parent-result.json).

- Portable workspace actions: actual Cloudflare runtime checkpoint passed, moderate difficulty.
  The committed9a0a556 full Next build runs against isolated Neon through the auth service
  binding. The real reviewed action reaches argument validation; unknown action IDs, headerless
  form posts and cross-origin submissions are rejected, and anonymous actions/discovery require
  authentication. Auth, task ownership, transactions, logout and expiry checks also pass.
  This run performs no Coder lifecycle mutation; account-backed lifecycle and browser acceptance
  remain. CI, image builds and native guardian build all pass for pushed9807fbc.
  Evidence: [workerd actions](cloudflare-auth-portable-actions.json).

- Preview application/rotation schema: completed, moderate difficulty. The committedf2c7a0f
  migration runner upgrades isolated Neon24→26 after verifying the prior history and all
  table hashes. All31 existing table hashes and24 prior migration records are unchanged.
  Four new tables receive only SELECT/INSERT/UPDATE for the runtime role; schema creation
  and DELETE remain denied. No production database, cron or remote credential changed.
  Evidence: [preview schema26](neon-source-application-rotation-migration.json).

- Source input and metadata application: reviewed assembled checkpoint, high difficulty.
  Durable supervisor/controller barriers close terminal and model input while exact factual
  reads and revocation remain possible. The fixed FD3 helper applies accepted Git metadata
  without rewriting worktree bytes. Lost-commit-ack recovery preserves HEAD/index/receipt
  bytes, inodes and timestamps and does not reserve or commit twice. Parent checks pass56
  source,33 Python,146 compiled behavioral and60 packaging tests, plus13 installer tests
  and the actual fixed installer. Optional fixture/scale cases remain explicitly skipped.
  The initial guardian-inclusive gzip exceeded the existing160000-byte budget at165416;
  standard XZ reduces the same607744-byte tar to132420 bytes. Bounded single-stream decoding,
  exact tar hashes and legacy gzip/tar support remain; malformed/oversized inputs are tested.
  This is still disabled capability packaging. Signed server/outer application composition
  and installed account-backed acceptance follow before activation. Evidence:
  [input contract](source-input-application.md), [parent assembly](source-input-local/parent-result.json).

- Rotation cutover control: completed and independently reviewed, low difficulty. A selective
  Node rotation-worker switch leaves template and notification workers running, skips queued
  rotation jobs and stops between pages. Eight focused checks pass. It neither interrupts an
  in-flight provider operation nor removes Redis scheduler records; the cutover procedure
  requires draining every old instance before enabling Cloudflare rotation. No flag changed
  in any deployed environment. The source-input/XZ checkpoint is pushed; priorf2c7a0f CI,
  image and native guardian builds are all green.

- Cloudflare assembled runtime regression: completed, moderate difficulty. The committed
  source-input/XZ build1a7fea2 passes the combined auth/task/workspace-action and nine host
  callback transport proof against isolated Neon26. Ownership, logout/expiry, transaction
  rollback, forged/unknown host rejection and private-route boundaries pass. An initial
  harness invocation omitted its required `--callbacks` option and stopped before startup;
  the corrected run passes. This is local workerd, with no deployed flag or Coder mutation.
  Evidence: [assembled workerd](cloudflare-auth-source-input.json).

- Nested source-recovery CI fixture: corrected, low difficulty. CI1a7fea2 passed96 of97
  template checks, but the Node→Python→Node recovery fixture inherited the parent runner's
  private IPC context and returned no report. The parent reproduced the failure, removed
  only that inherited runner context and required explicit TAP output. The nested check
  now passes on Node24 and CI's22.23.4; its strict pass-count assertion remains. Migration
  integration and app/native image builds already passed. Runtime code was unchanged.
  Evidence: [CI fixture correction](source-input-local/nested-runner-ci.json).

- Signed source application: reviewed assembled checkpoint, high difficulty. Signed server
  actions now bind the runtime generation under the database lock, and the outer controller
  checks fixed private journals and pinned Git metadata before accepting application.
  A composed real PostgreSQL/Python FD3 test survives lost reservation and commit replies
  without repeating either write. Review caught a post-response metadata gap; fresh physical
  checks now retain the hold when HEAD, index or receipt changes during a response.
  Parent clean-export validation passes215 database tests,373 runtime tests and97 template
  tests, plus172 nested compiled behavioral checks, typecheck and the actual fixed installer.
  Explicit opt-in cases remain skipped. CI also exposed a stale diagnostic source marker;
  its narrowly updated assertion and full runtime rerun pass, with the failed log retained.
  The guardian-inclusive XZ package remains within the unchanged160000-byte limit at135892.
  Synthetic enrollment/native observations in the composed test are documented; full installed
  manager execution and account-backed acceptance remain open. No deployment flag changed.
  Evidence: [signed application](guardian-source-application-actions.md),
  [composed proof](guardian-application-installed-local/README.md),
  [parent assembly](guardian-application-local/parent-result.json).

- Installed manager composition: reviewed packaged checkpoint, high difficulty. A separate
  default-off execution flag now composes the existing manager, native observer, publisher,
  source-state client, metadata application and scoped GitHub collector. Independent review
  found registration revocation could arrive during a guardian FD reply; callbacks now check
  lifetime before and after awaits and propagate cancellation to the fixed helper. Late results
  retain the hold. The actual helper abort/reap regression passes; an eight-second shutdown
  deadline remains an uncertain hold, never proof of physical termination.
  Parent clean-export checks pass389 runtime tests,187 nested compiled behavioral tests,
  98 template tests,3 deployment-policy tests, typecheck and the actual fixed installer.
  Optional fixture cases remain skipped. Packaging initially exceeded Coder's1MiB limit by
  retaining loose copies of verified archive members. Reviewed installer reference handling
  removes that duplication; the software template is450048 bytes and the guardian-inclusive
  XZ package137848 bytes, within unchanged limits. Initial export dependency/link failures
  are retained alongside corrected passing runs. Full installed source progression, the
  model-facing evidence status tool and the account-backed pilot remain open. No deployment
  flag changed. CI, app images, workspace images and native guardian builds pass328283f.
  Evidence: [installed composition](installed-delivery-factory.md),
  [parent assembly](installed-delivery-factory-local/parent-result.json).

- Portable template publication: reviewed foundation checkpoint, high difficulty. Existing
  templates now have owner/session-bound durable stages, globally serialized targets, fixed
  artifact hashes and bounded replayable progress. Ambiguous version creation or activation
  retains a hold; no blind retry publishes a second version. Fresh and26→27 migration proofs
  preserve all35 prior table hashes. Parent validation passes126 checks including16 real
  PostgreSQL cases, typecheck and schema validation. Nine actual workerd checks use the full
  PrismaNeon client against local PostgreSQL with synthetic auth/Coder bindings, covering a
  successful publication and both uncertain outcomes. Workerd caught unsupported redirect
  handling in archive loading; explicit manual redirect rejection fixes it, with the initial
  failure retained. Jobs process one stage per wake and require explicit private bindings.
  An initial schema-check command used the wrong package context; the pinned database-package
  command passes. First creation, provisioner-tag/variable parity, detailed log viewing and
  live provider acceptance remain. No cron, remote template activation or production change.
  Evidence: [publication contract](template-publication-design.md),
  [workerd proof](template-publication-local/workerd.md),
  [parent checks](template-publication-local/parent-result.json).

- Installed source progression: completed local composition, high difficulty. The actual
  factory now crosses signed PostgreSQL services, outer journal validation and Python/Git
  application before issuing one dependent-step continuation. Real composition exposed a
  protocol field on the current claim that earlier synthetic journals had incorrectly placed
  at the top level. The fixed reader and actual-spool regression pass. Parent checks pass
  nine PostgreSQL cases,34 runtime cases and188 nested compiled cases; optional cases remain
  skipped. Typecheck and synchronized template checks pass. Clean exports initially failed
  on optional Git revision metadata; source hashes remain mandatory and the corrected proof
  passes. Native execution, initial enrollment and provider results remain explicit doubles;
  this does not establish the real-account pilot. Evidence:
  [parent composition](installed-delivery-factory-local/parent-composed.json).

- Neon publication migration and assembled application: completed, moderate difficulty.
  Preview schema27 preserves26 migration checksums and all35 prior table hashes. The runtime
  role has only SELECT/INSERT/UPDATE on the three new tables. The committed Cloudflare build
  passes auth, task, portable-action and nine host-callback transport checks against Neon27.
  Publication CI exposed a missing Coder host environment setting; its corrected16 database
  tests pass. Two evidence JSON files also needed formatting. Production and deployed feature
  flags are unchanged. Evidence: [Neon migration](neon-template-publication-migration.json),
  [assembled application](cloudflare-auth-template-publication.json).

- Template creation and update parity: completed local implementation, high difficulty.
  Schema28 reserves a catalog name before the first remote template exists and permits one
  UUID binding after verified creation. Unknown version/template outcomes retain a hold.
  Existing-template pushes preserve provisioner tags by a canonical digest; variable values
  stay on Coder, matching its CLI behavior. Stdin template archives do not use README metadata.
  Parent clean-export validation passes113 checks including26 PostgreSQL cases and typecheck.
  Thirteen actual workerd checks cover first creation followed by update and ambiguous effects.
  A populated27→28 rehearsal preserves old columns/rows across38 tables, including90 publication
  jobs. Migration27 is unchanged. Detailed logs, durable completion notifications and live
  provider acceptance remain. No provider mutation or deployed flag change. Evidence:
  [creation and parity](template-publication-creation.md),
  [parent validation](template-publication-creation-local/parent-result.json).

- CI checkpoint: c3448f8 passes CI, application/workspace image builds and native guardian build.
  The composed factory regression now runs in the PostgreSQL job. The corrected publication
  test environment and evidence formatting pass in CI.

- Portable workspace reads and factual delivery status: reviewed assembled checkpoint,
  high difficulty. Existing session lists, file checks and tool directory lookup now use
  an independent signed, owner/build/app-bound service in Cloudflare. A review found stale
  tool-link metadata; link creation now consumes the verified binding and rechecks the exact
  owner/build/agent before authorizing a tool URL. Per-action streamed body limits preserve
  large valid path batches without expanding unrelated actions. The manager can read current
  claim/source/evidence prerequisites without turning a status response into write authority.
  Collection refreshes only after fresh current-claim checks and is coalesced/bounded.
  Parent clean-export checks pass164 focused cases,101 template checks,64 runtime checks,
  196 nested compiled cases and22 Python boundary cases, plus typecheck and actual guardian
  startup. Optional native cases remain skipped. The standalone read installer also passes
  an independent actual private-home/network proof; its test-only root-ownership observation
  is explicitly documented. An initial proof-output path was outside the harness evidence
  directory and was rejected; the corrected path passes. Both services initially left too
  little pod annotation room. Compressing only the pinned read installer keeps the unchanged
  limit:229256 fixed bytes plus8192 config reserve under240000. The decoder checks bounded
  single-stream gzip and SHA256 before startup. Native/provider doubles in composed delivery
  remain explicit; live Coder installation, full app and browser acceptance follow.
  Evidence: [parent assembly](workspace-read-install-local/parent-assembly.json),
  [read installer](workspace-read-installer.md), [status contract](delivery-status.md).

- Preview schema28: completed with all38 existing tables' old columns/rows and migration
  records preserved; publication-table runtime grants remain SELECT/INSERT/UPDATE only. The preflight initially
  rejected legitimate column names containing digits before any migration; its identifier
  validator was corrected and the reviewed migration/verification passed. No production access
  or cron activation. Schema28 CI and all image/native builds pass5c7ea17. Evidence:
  [Neon verification](neon-template-creation-migration.json).

- Full Cloudflare application regression: completed, moderate difficulty. Committed2294726
  passes the auth/task/portable-action proof against Neon28 and all ten enabled callback
  transport rejection checks. This does not activate workspace-read/status or establish live
  Coder acceptance. Evidence: [assembled application](cloudflare-auth-workspace-read-status.json).

- Terraform specialist validation: completed, low difficulty. A task-created disposable
  Infrastructure workspace validated the exact committed template snapshot with Terraform1.15.8
  and pinned providers. All five profiles pass with zero errors/warnings. Formatting found two
  alignment differences in the shared read bootstrap; the corrected generated copies and
  artifact manifest are synchronized. The primary independently compared every returned source
  hash before completion. No plan/apply or production credentials were used. Evidence:
  [specialist validation](template-infrastructure-validation/validation.json),
  [primary completion](template-infrastructure-validation/completion.json).

- Node22 CI regression: completed, moderate difficulty. The status fixture waited on an
  intentionally unreferenced background timer without a real host listener. A bounded test
  observation deadline fixes the fixture lifetime without changing production behavior.
  Node22.23.4 and Node24 each pass49 cases plus one existing native skip; compiled factory
  proofs pass13 nested cases each. The original failure is preserved alongside the fix.
  Evidence: [CI reproduction](delivery-status-local/ci-node22.json).

- Infrastructure validation cleanup: completed. The installed receipt-based helper stopped
  the disposable and its reaper requested deletion; a fresh Coder read returns410 Gone.
  Preserved completion evidence is unchanged. No raw deletion or unrelated workspace action.
  Evidence: [cleanup verification](template-infrastructure-validation/cleanup.json).

- Project reconciliation cancellation plumbing: implemented and reviewed. A caller-provided
  abort signal now reaches Coder/guardian/host requests; database operations finish before
  return, and unknown interrupted host outcomes retain their durable claim for recovery.
  Parent checks pass21 focused cases. This is request-local cancellation only: actual workerd
  inspection showed service-binding caller cancellation does not automatically propagate to
  the app. An authenticated app-enforced deadline and response-independent database cleanup
  are being validated before the private reconciliation route is enabled.

- Live template import uncovered a distribution bug, moderate difficulty. The first directory
  upload exceeded Coder's one-MiB limit; the maintained544768-byte artifact then reached the
  provisioner but failed before Terraform because its tar omitted parent directory headers.
  The builder now emits deterministic directories before files; source content identity and
  file counts still include regular files only. A new extraction regression creates no
  implicit parents. Packaging and consuming hash/artifact tests pass; live re-import follows.
  No active template version or production workspace was changed by the failed imports.

- Real inactive Coder import: completed after the directory-header fix9ea8aca. The545792-byte
  maintained artifact imports successfully with pinned providers and the reviewed guardian
  binary. The existing persistent codex test workspace now runs that inactive version with
  the read service enabled; global active template remains unchanged. Its first signed read
  exposed an installed agent-ID mismatch and correctly returned403; diagnosis is ongoing.

- Native CI opt-in repair: completed. f14f569 fixes the status test and passes all image/native
  builds, but ordinary Node22 CI then reached an installer proof requiring root-owned
  /usr/bin/node24. The existing dedicated probe already set an opt-in variable, but the
  test omitted its guard. Restoring that guard leaves3 portable bootstrap checks enabled
  and skips the native-only case by default; explicitly opting in passes the real isolated
  installer proof. Production runtime code is unchanged by this correction.

- Private Cloudflare task reconciliation and template logs/notices: parent validation complete
  locally, high difficulty because actual Worker cancellation and database lifetime differed
  from simple request mocks. Jobs call one fixed authenticated app wake; the app enforces its
  deadline and closes its database before returning even if the caller disconnects. PostgreSQL
  statement timeout57014 and recovery after a late host effect pass actual workerd checks.
  Template logs remain explicit authenticated memory-only reads; terminal publication results
  create a durable notice with bounded retry. Review caught and fixed a sender timeout that
  could return before pending database work settled. The parent schema29 export passes82
  distinct focused cases,42 real PostgreSQL cases, typecheck and actual workerd reconciliation.
  Native installer opt-in also passes. Provider/push doubles and absent live browser acceptance
  remain explicit. All new flags stay off; remote Neon migration29 follows this commit.
  Evidence: [parent assembly](template-publication-logs-parent.json),
  [actual Worker recovery](project-reconciliation-parent.json).

- Preview migration29 and assembled application: completed, moderate difficulty. The direct
  preview migration runner applies the reviewed additive notice migration; all38 pre-existing
  tables preserve their old-column row hashes and all28 prior migration checksums. The new
  notice table grants SELECT/INSERT/UPDATE without DELETE; schema creation remains denied.
  Existing old-table permissions are unchanged. Full-Next local workerd2970a7d then passes
  auth, encrypted credentials, ownership, rollback, portable actions and ten malformed callback
  rejection gates against Neon29. This is actual app/DB execution with controlled provider
  operations, not live workspace or browser acceptance. No production traffic or schedules.
  Evidence: [Neon29](neon-template-notices-migration.json),
  [assembled application](cloudflare-auth-template-reconciliation.json).

- Repository policy foundation: complete as a bounded slice, high difficulty. Schema30 preserves39 existing tables and migration history. Parent27 focused checks,33 packaging/runtime checks and independent17 PostgreSQL checks pass; broader361 pass. Review caught missing runtime grants and a legacy-fallback bypass, both fixed. Generic CI cannot satisfy task meaning; independent semantic evaluation and exact nondefault branch resolution remain.
- CI terminal tests: fixed the Next server-action boundary in three jsdom suites; all14 checks pass. Production server-only guards are unchanged.

- Epic source selection: implemented and independently reviewed, moderate difficulty. The deployment catalog selects an exact GitHub branch ref and the controller pins its commit before enqueue. Project UI shows the branch; stale revisions cannot start a task. Missing or malformed policy leaves conversations accessible with task start disabled. Python15, parent48 application checks plus21 review-regression checks, Node54 and independent32/15/40 checks pass. Installed acceptance remains.

- Coder runtime identity: source fix implemented and independently reviewed, high difficulty. Actual authenticated manifest read confirmed Terraform and runtime agent UUIDs differ. A pinned official SDK helper now verifies provisioner build/app/workspace metadata before normalization; same-build identity changes remain blocked. Parent30 Python/5 Node checks and102 template checks pass; all5 Terraform profiles validate without warnings. Real new-image startup remains the next gate.
- Preview policy migration: schema30 applied from6a55bb5, with39 existing tables and migration checksums preserved. New policy tables have restricted runtime grants. Production untouched.

- Assembled application at014d08e: complete locally against real Neon30. Auth, encrypted
  credentials, transactions, owner isolation, portable actions and malformed callback guards
  pass through actual Next/workerd service bindings. All pull-request CI workflows also pass
  at this revision. This is not installed workspace or browser acceptance. Evidence:
  [assembled application](cloudflare-auth-identity-source.json).

- Private project candidate preparation: implemented, moderate difficulty. The explicit
  workspace-projects candidate requires the existing owned preview, native gateway, retained
  scoped issuer and current software read-package manifest. Preparation and upload validation
  agree on flags, profile pin and secret bindings; tasks/background execution remain disabled.
  Ten focused deployment checks pass. No candidate was deployed by this step.

- Preview image build: build, smoke and registry publication pass for014d08e, but the final
  identity-recording step failed. The image is not yet accepted for workspace startup; the
  registry/runner identity mismatch is under investigation. No production image alias or
  active template was updated.

- Infrastructure identity validation cleanup: complete. The installed receipt-based wrapper
  stopped and requested deletion of the task-created validation workspace; a fresh primary
  read confirms410 Gone. Completion evidence remains preserved. Evidence:
  [cleanup](identity-template-validation/cleanup.json).

- Preview image provenance: recovered and recorder fixed, moderate difficulty. Build/export/
  push logs and independently hashed registry manifest/config/layers identify the same014d08e
  image and root-owned helper. Docker's containerd image store reports the manifest as its
  local image ID; the recorder now supports that and the classic config-ID form. Four Python
  checks pass. The original failed workflow remains visible. The inactive557056-byte template
  imports and the dedicated test workspace connects on that image, but reports a startup
  script error under investigation. Evidence: [image recovery](workspace-image-preview-recovery.json),
  [template/build inputs](workspace-identity-live/template-input.json).

- Generic Cloudflare terminal transport: implemented and independently reviewed, high
  difficulty because connection renewal must retain the existing remote PTY and distinguish
  temporary auth failures from revoked sessions. Seventy-one focused checks, three portable
  manifest checks and typecheck pass; the parent separately reruns32 focused checks. Actual
  local workerd passes12 checks with drained processes and matching source hashes. Review
  caught flattened auth failure types, now fixed; initial failures are preserved. The feature
  stays off pending actual Coder/browser validation. Evidence:
  [terminal validation](generic-terminal-local/validation.json),
  [parent review](generic-terminal-local/parent-review.json).

- Installed workspace identity and repository reads: complete on the reviewed e9230f1 image,
  high difficulty. Real Coder's canonical named-app label omits the agent component; the
  helper now checks that separately from the configured explicit-agent alias. The new image
  passes build/smoke/provenance, imports as an inactive version, and starts successfully in
  the dedicated persistent test workspace. The reviewed live probe passes55 direct requests
  plus one receipt-inspection SSH: signed identity/session/CWD/path reads, GitHub discovery,
  exact epic ref, package/process receipts and credential isolation. A separate read-only
  preflight confirms no enrolled controller project or managed checkout for the browser target.
  No model inference, project enrollment, active-template update or production change.
  Evidence: [live runtime](workspace-runtime-identity-live-e923.json),
  [controller preflight](workspace-identity-live/controller-inventory-e923.json).

- Ordinary clipboard transport: implemented and independently reviewed, high difficulty.
  Parent100 focused checks and nine real Python PTY checks pass; matching-source local workerd
  passes nine checks including the full20 MiB multipart limit. Fixed commands, nonce/digest ACKs,
  exclusive partial files and a bounded helper lifetime replace SSH in this disabled candidate.
  Review caught preexisting-partial cleanup and malformed upgrade socket handling; both are
  fixed. Real Coder/browser and deployed CPU/memory acceptance remain pending. Evidence:
  [upload validation](terminal-paste-local/validation.json),
  [parent review](terminal-paste-local/parent-review.json).

- Private project preview deployed at e9230f1; public URLs remain disabled. The seven-check
  live smoke stopped on request five: Next middleware redirected the project API to login
  HTML instead of its route-owned JSON error. The failed result is preserved. The repair
  routes only exact project API methods to their existing authentication handlers; review
  corrected task status to POST. Repository opening now follows discovery capability, while
  task creation/retry/polling remain separately disabled. Parent35 UI/route/middleware checks
  and12 deployment-policy checks pass. Owned private previews can now be repaired after a
  recorded failed probe without weakening identity/version/private-state/headroom checks.
  Browser validation and the repaired deployment remain next. Evidence:
  [first live failure](cloudflare-project-preview-smoke-e923.json).

- Project browser Phase A: complete on deployed a92e305, moderate difficulty. Real Browser Testing Chrome confirms fixed Coder login, secure cookie, exact GitHub account/repository discovery, search, task-null project enrollment, desktop/mobile widths and logout. First harness pin accidentally used the separately retained Node build; second run blocked a harmless marketing RSC prefetch. Both failures remain preserved, and the final run passes55 requests,148 cumulative outer exchanges. No tasks, model calls or WebSockets were started. Both Workers are private again. Shared-session Phase B remains pending a real registered task. Evidence: [browser](project-preview-browser/browser-a92-final.json).
- Independent acceptance: c53c785 completes the default-off reviewed producer slice. Immutable encrypted intent, durable plan/review jobs, exact source material and native evaluator provenance now compose locally. Independent review corrected empty-file handling and required exhaustive bounded archived history. Parent18 PG checks and8 compiled suites, including actual native evaluator checks, pass; all profiles include the reviewed package. Semantic repair loop, installed account-backed pilot and remote schema31 are next; no production activation. Evidence: [acceptance](independent-acceptance.md).

- Preview schema31: complete, moderate difficulty. The existing migration runner applied the reviewed c53c785 acceptance migration only to hive_app_preview. A first hash comparison raced the separate workerd fixtures; after fixture cleanup, all42 prior table hashes and30 migration checksums match exactly. New intent/plan tables deny UPDATE/DELETE; jobs allow UPDATE and deny DELETE. Actual assembled app/auth Workers proof passes from7cc2bfb against schema31. Production untouched. Evidence: [migration](neon-independent-acceptance-migration.json), [app proof](cloudflare-auth-independent-acceptance.json).

- Acceptance repair review: one current-source database fence was missing from the failed-attempt
  transition. The application already checked it; migration33 is being tightened and a direct-SQL
  regression added. The frozen checkpoint otherwise passed independent hash verification and37
  adapter checks. Controller-derived completion is separate ongoing work; no full autonomous
  task-success claim is made yet.
- Voice review: the pending-cancellation/late-acknowledgement correction passes independent12
  checks and the implementation suite passes69 focused cases plus local workerd transport.
  Real Codex startup/disconnect semantics still require the dedicated workspace/browser pilot.
- Packaging correction: separate ConfigMaps fit the size limits but conflict with the provisioner's
  previously observed permissions. That candidate is superseded by root-owned image-baked public
  packages with small Downward API requests, preserving template-pinned hashes and avoiding new
  cluster permissions. This replacement needs its own template/image/live-startup validation.
- D09 release control: the journal, target locks, before-effect receipts, recovery, private readiness
  probes and build attestation have local implementation/tests. The trusted publisher, controller
  integration and complete policy producers are still being built; no release authority is active.
- Production-data rehearsal: the stored database address refuses connections and this workspace
  has no Kubernetes credentials. A reachable read-only database connection or existing backup has
  been requested; the remaining implementation work continues independently.

- F08 capture preparation: implemented and reviewed locally. A read-only exported snapshot now
  produces a private bounded archive and SHA-256 row fingerprints. The PostgreSQL17 fixture
  proves a concurrent insert is excluded from both captured rows and restored data. Review
  findings on streaming byte limits, shared deadlines and directory replacement were corrected;
  the parent independently reran all4 tests. This is synthetic local data, not a completed
  production-data migration. Evidence: [capture proof](data-capture-local.json).

- Repair/completion and packaged voice checkpoint: reviewed, high difficulty. The failed-attempt
  SQL source fence and composed repository/semantic evidence filtering were corrected. Parent
  validation passes26 PostgreSQL tests on a fresh database containing only committed31 plus
  repair33, all105 template tests,449 runtime checks with20 optional skips, and6 private readiness
  tests. All five profile artifacts are synchronized; a reviewed guardian ships by default while
  execution stays opt-in. The matching-image Coder build and account-backed browser pilot remain
  pending. Evidence: [parent review](repair-voice-parent-review.json),
  [controller completion](acceptance-completion.md).

- Isolated Neon repair migration: complete. Committed9db3f5f applies repair33 after the31
  already applied migrations (32 entries total; uncommitted release migrations are excluded).
  All45 prior table hashes and31 migration checksums are preserved; the runtime still cannot
  create schema. The clean Cloudflare build and auth-only local-workerd check pass against
  that database. The first evidence copy mistakenly selected an old full-app report; it is
  retained as cloudflare-auth-repair-stale-selection.json and is not evidence for9db3f5f.
  The explicit full-app/portable-actions/callback run reached its route assertions but failed
  fixture cleanup due to a database connection timeout. The failed report is retained;
  the unchanged committed9db3f5f retry passed, including fixture cleanup.
  Evidence: [full app proof](cloudflare-auth-repair-completion.json),
  [initial cleanup timeout](cloudflare-auth-repair-cleanup-failure.json).
  Evidence: [migration](neon-repair-migration.json).
- CI correction: the PostgreSQL job passed at9db3f5f; broad CI found a missing Prisma export in
  one guardian-test mock and an older evidence JSON formatting discrepancy. fe62afb fixes both,
  with6 focused checks passing. New CI is pending. The preview image built and passed its normal
  CLI smoke, then failed the new public-bootstrap integrity check before publication.494cf3e
  adds bounded diagnostic output without relaxing any ownership or digest check; its image
  workflow also failed: the runtime archive was inaccessible to the image user.
  781bb9d explicitly restores directory traversal while keeping files read-only and adds
  directory-search permission validation; image verification is pending.
  No failed image was installed or published.

- Agent tools bridge: local implementation/review complete, moderate difficulty. Review caught
  stale tmux-server environment affecting custom agent homes; fixed and independently verified
  with21 helper tests. Five parent packaging/host checks pass. Committed24a454c remains disabled
  by default. Exact-source image workflow41034024253 is running before installed Coder validation.
- CI recovery: both fe62afb and494cf3e passed the full CI workflow. The current24a454c
  candidate is undergoing CI. No production cutover or release controller activation.
- D10 review: the first20-test foundation passed, but independent review found an integrity
  snapshot race and receipt-expiry window. Corrections and actual Prisma lock interoperability
  are in progress. This is not a completed migration/backfill acceptance gate.

- Agent bridge application build: exact committed24a454c Cloudflare build and full local-workerd
  auth/app/callback/portable-action proof passed against the isolated Neon runtime role, including
  fixture cleanup. No real Coder mutation or cloud deployment is represented by this test.
  Evidence: [application proof](cloudflare-auth-agent-bridge.json).

- Main reconciliation (2026-11-05): complete, moderate difficulty. Rebased the epic onto main 1ace8774 under the user’s explicit authorization. Preserved the keycap dock, user-managed Codex module, optional Sysbox Docker, removed private defaults and version 2.33.0. All704 saved local paths restored;703 are byte-identical, and package.json retains the new main version plus unfinished release tests. Focused checks pass:38 UI,108 template,454 runtime (21 optional skips), typecheck and actual pinned-runtime Unix-socket isolation. The user CLI update is separate from the pinned managed-session runtime. Release, database-job and multi-task integration remain in progress; earlier preview proofs are historical. Evidence: [rebase verification](rebase-20261105/result.json).

## 2026-11-05 implementation and migration checkpoint

- Main reconciliation: complete. The authorized rebase preserves main `1ace8774`, including dock
  keycaps, user-managed Codex configuration, optional workspace Docker and the current release
  version. Backup and private stash remain retained. Focused template/runtime/UI checks passed.
- D09/D10 implementation: committed at `52c4b2e0`. The real old/new Worker and Neon pilot passes
  mixed-version reads/writes, transaction rollback after a deliberately interrupted backfill,
  durable restart, six-row backfill, integrity and post-write checks. Authorization/provider
  observations remain fixtures; this is not production release acceptance. See [pilot](d10-mixed-pilot/README.md).
- Release validation fixes: absolute Wrangler output paths now match the artifact packer. CI
  exposed a Node Request garbage-collection abort race; the probe retains its Request until
  cancellation completes, with a forced-GC regression check. Current CI rerun follows source freeze.
- F08 restore/upgrade: complete for row preservation, high difficulty due to cluster transport
  and PostgreSQL tooling differences. Read-only capture: eight tables, 88 rows, 25,654 bytes.
  Local and isolated Neon upgrades preserve every original row and have all 39 migrations.
  No production writes or cutover. [Redacted proof](production-data-capture/20261105-restore-upgrade.json).
  Application/session, restricted-runtime and recovery checks remain pending.
- D11/D12: local process closure, source preservation, second reservation, two actual guardian
  lifetimes and installer re-entry pass. Independent review is resolving manager-facing planning
  usability before the current package is built for the installed Coder pilot.
- F08 backup recovery: complete for the isolated local PostgreSQL copy. The upgraded database
  backup restores into a second new database with all 68 tables and 120 rows matching. The
  first target-creation attempt inherited the capture tool's read-only setting and correctly
  failed; write capability was enabled only for the explicitly identified local restore target.
  This is not a Neon point-in-time restore or a post-cutover write-recovery proof.
  [Recovery result](production-data-capture/20261105-recovery.json).
- F08 application/session rehearsal: passed with the real 52c app/auth Workers, synthetic keys
  and sessions, and a restricted role on the restored Neon database. Invalid/expired sessions,
  wrong keys, task access and logout behaved as expected; all original fingerprints matched
  afterward. Original production keys and real sessions were not exercised.
  [Attempts and limitations](f08-restored-app/README.md).
- D11 installed startup: image 0dc built and inactive template imported; actual host startup exposed
  a group-writable provisioner-owned home. Fix `041ddd79` uses the existing private runtime root
  with unchanged ownership checks. Two CI fixture failures and a missing shutdown callback were
  also corrected; the actual PostgreSQL guardian composition now passes.
- Authentication correction: `1c815357` rejects malformed HMAC suffixes before hex decoding;
  11 cookie checks pass. The restored-data proof predates this narrow change; a current Worker
  rebuild and preview proof follow.
- GitHub live delivery pilot: [concrete plan](github-preview-pilot-plan.md) records isolated branch,
  reviewer/producer, protected environment and preview-only release requirements. The current
  connection gets 403 for environment/secrets access; an appropriately scoped setup token is
  requested while independent validation continues. No main policy or production route changed.

## 2026-11-05 current preview integration

- Private Cloudflare preview update: app and auth now run f811 with provider identity readback.
  The original database, encryption and issuer secrets were preserved; no production routes or
  scheduled jobs were enabled. Current local assembled Worker proof passes. Live guarded
  application and browser checks remain pending.
- Delivery pilot configuration: implemented and independently reviewed at f4a18bee, moderate
  difficulty. Terminal runtime configuration and explicitly scoped shared issuer mode avoid
  regenerating the existing host key. Focused tests and typecheck pass; actual installed-runtime
  verification follows the current Worker rebuild. The temporary synthetic Cloudflare inheritance
  experiment showed rename semantics cannot duplicate bindings; its Worker was deleted after
  matching its recorded identity. No real issuer was used in that experiment.
- Test workspace startup: corrected f811 image is healthy in the primary test workspace. The
  second dedicated software workspace is retained with valid dedicated Codex authentication,
  but a separate first-boot CLI ordering race needs the template fix before full acceptance.
- CI: current f811 migration, formatting, lint, quality, Helm and image checks passed. A nested
  runtime test still fails only on GitHub; f4a18bee preserves its child diagnostics so the actual
  assertion can be fixed. No test was disabled or acceptance gate weakened.

- Account connection roadmap addition (2026-11-05): documented at the user's request; no auth
  implementation or account flow was started. Read-only inspection of Creative Studio's admin
  worktree confirmed Coder authorization-code/PKCE plus encrypted refreshable credentials and
  a Codex device-code UI. Claude has no verified equivalent in that reference. F09/F10 capture
  the requested app-managed connections, storage investigation and separate acceptance gates.

- Current revision `6dc61a50`: full CI passed; the actual app/auth Worker and scheduled-job
  integration proofs passed using the same validation checkout and generated Prisma inputs.
  Both preview Workers were deployed with existing secrets preserved. The jobs Worker was
  created with no public URL and no schedule.
- Live preview attempt: the guard, real Coder login and exact test-agent metadata read passed.
  Project opening returned `502 discovery_unavailable` before any task-start request. The
  existing host journal predates this attempt; it does not establish current request delivery.
  The provider cookie exchange works from the primary runtime, but that does not prove the
  Worker's network path. Difficulty: integration diagnosis; fixed-stage, credential-free
  diagnostics are the next step. App public URL was disabled afterward; jobs remains unscheduled.
  See [bounded live evidence](cloudflare-live-project-pilot-6dc61a50.json).
- Follow-up `3f5b203c`: CI, the rebuilt app/auth integration and actual scheduled-handler
  proof passed. A two-request live diagnostic reused the existing session and identified a
  `403` at the signed host response, after app-cookie exchange. The filtered temporary tail
  was removed and the app URL closed; no task was enqueued. The scoped Neon enrollment
  reader now works without the private compatibility wrapper.
- Workspace integration correction `6ea9a500`: the guarded worker's fixed `/usr/bin:/bin`
  path had no Coder CLI, while the installed GitHub helper invokes `coder`. A matching
  vendor-pinned CLI is now installed by the image at `/usr/bin/coder`, with archive ownership
  discarded; independent review and eight actual-install-command fixtures passed. The
  existing test workspace disallows privilege elevation, so no in-place binary change was
  made. A fresh test image/workspace is required to prove the live repair; existing guarded
  hosts and their journals remain intact. Difficulty: integration issue exposed by live
  validation, not established by the earlier mock-provider tests.

## 2026-11-05 Cloudflare environment provisioning

- Production target setup: completed as inactive reservations, low difficulty. Created
  `hive-app-production`, `hive-auth-production` and `hive-jobs-production` in the existing
  account from reviewed `dbe91300` bootstrap bytes. All return only an unavailable response;
  provider readback confirms no public/preview URLs, routes, custom domains or cron schedules,
  and no database/secrets bindings. This is environment provisioning, not a production app
  rollout or a completed cutover gate. Four configuration/handler checks and three Wrangler
  dry-run uploads passed. [Provider receipts](cloudflare-production-reservations.json).
- Preview environment: existing app/auth/jobs deployed at `01eb03ba` are retained. Enabled
  only the guarded app URL for continuing preview checks; auth and jobs stay private and jobs
  unscheduled. The actual SSR login returns 200/private-no-store with preview authorization;
  an unauthorized validation request returns 401. Initial Python-default-client requests
  returned 403 and are preserved separately. Four outer requests in this step bring the
  incremental ledger to 21/200. [Passing smoke](cloudflare-environment-smoke-retry-20261105.json).
- Installed host repair: the fresh `hive-epic-flow` workspace includes the pinned Coder CLI
  on the guarded PATH; current preview project-open succeeds against that host. A subsequent
  one-shot task-start attempt did not retain its HTTP response. Read-only reconciliation found
  no intent/task/policy rows; its cause and original response remain unknown. It was not replayed.
- Task-start diagnosis: fixed-stage, credential-free logging implemented and independently
  reviewed at `dbe91300`; 13 focused tests, TypeScript and Biome pass. These diagnostics are not
  yet in the deployed `01eb03ba` app. Attach a bounded filtered live tail for their next deployment;
  retained observability is disabled. Current full manager/browser/epic acceptance remains open.
- No production data, DNS, Kubernetes runtime, or release authority was changed. Account-connection
  F09/F10 remains the deferred roadmap scope. Environment identities and handoff sequence are in
  [Cloudflare environments](../../../deploy/cloudflare/environments.md).

## 2026-11-05 native Preview correction and Git builds

- Deployment direction corrected at the user's request: one parent Worker `hive`, using
  native branch Previews and in-process app/auth/jobs composition. Read-only references were
  Creative Studio's integration worktree and Top Decor Ledger; neither was changed. The three
  task-created inert production reservations were verified and retired, with receipts retained.
  The compatibility pilot Workers were initially retained private and unscheduled; their later
  user-directed retirement is recorded below.
- Implementation/review: native composition, exact-origin configuration and deployment guards
  are committed at `feecfcb7`. Scheduled failures now wait for sibling handlers to settle;
  source readiness includes native/jobs handlers and is enforced before publication. Sixteen
  focused checks, TypeScript and Biome pass. Actual assembled Workerd proof and dry-run upload
  pass at feec, including inline auth, SSR, synthetic session/task reads, logout, portable
  actions and terminal checks. This is not real Coder/task/production acceptance.
- Isolated native preview database: new `hive_native_preview` and restricted
  `hive_native_runtime` on the existing Neon Free branch. Forty committed migrations pass;
  67 tables, zero user/session/project/task/intent rows at provisioning. Previous preview role
  cannot connect or access new objects. Fresh native app/auth keys are private; Preview Base
  receives only these preview keys. Old encrypted data/credentials are preserved separately.
- Git connection: user created the dedicated `hive` build token; primary configured repository
  root, pinned Node/pnpm, build and preview commands, main-only production command and caching.
  Production publication deliberately refuses activation. First PR-branch push automatically
  triggered build `62fb1228-0c3a-4c45-b040-216c8c81b5cf`, which succeeded. Its custom preview name
  differed from the provider-managed branch environment; the helper correction selects the raw
  branch and verifies provider metadata before deriving its exact origin. This URL association
  correction still needs the next actual automatic build and live validation.
- Native previews initially share only synthetic preview data/Base secrets across trusted
  repository branches. There are no R2/service bindings or host/delivery execution flags.
  Real manager/subagent acceptance resumes after the reviewed branch's issuer/host enrollment;
  production cutover and F09/F10 account refactoring remain open.

## 2026-11-05 deployment acceptance and actual idle-runtime repair

- Native PR preview: automatic push build `d41fddd0-b77e-44a1-885e-b2dd683a6c03`
  succeeded at `5c012a63` and updated the provider-managed branch environment. Effective
  bindings have no R2 or external services; origin and six secret names match the isolated
  native configuration. Guarded login SSR and real dedicated Coder sign-in passed. A real
  authenticated settings read returned the correct Coder host and five owned workspaces.
  Two harness assumptions (anonymous redirect and GET on a mutation-only route) are retained
  with their failures; the correct authenticated read passes. Incremental HTTP ledger: 31/200.
  The unused custom-named preview was identity-checked and removed after the managed preview
  was verified. Main production remains the inactive bootstrap, not the running application.
- Installed idle transition: held before rebuild. Inactive template `607a411d` was imported
  without changing the global active version. The existing test workspace's supported idle
  shutdown recorded `guardian_drain_uncertain`; no closure receipt exists, and its journal
  remains untouched. No restart/rebuild or fabricated closure followed that result.
- Runtime implementation repair: difficult, two concrete defects. The real empty-host callback
  required an adapter that exists only after admission; a separately missed inner controller
  barrier also prevented the next startup after a valid closure. The fix fences verified empty
  inventory, archives signed inner state against the prior authenticated tree receipt, then
  resets only that empty state. Crash replay and nonempty/tampered/newer state checks fail closed.
  Astra isolated the cause and implemented the bounded fix; Sol independently reviewed and
  reran 55 focused tests plus both real packaged installer tests. Those actual tests prove
  idle closure, ECHILD, changed-binding restart and a second closure, with no auth files or
  primary-path changes. Template packages are synchronized. This does not repair or certify
  the already-held live lifetime; a corrected test image still needs installed acceptance.

## 2026-11-05 native manager integration checkpoint

- Completed: commit `0398cbe0` passed GitHub CI and automatic Cloudflare Builds. Its
  actual assembled native Worker proof passed. A new dedicated test workspace on the
  immutable image passed a real idle closure and installed-helper restart on the same
  build. Its pinned Codex runtime is signed in using only the dedicated test account.
  The older uncertain lifetime remains quarantined and unchanged.
- Completed: one reviewed branch deployment enables the bounded manager, guardian,
  independent acceptance, documentation publication and shared project session. Provider
  readback matches the exact configuration, existing six preview secrets are preserved,
  and only the reviewed private R2 evidence bucket is bound. Production, database changes,
  epic scheduling and unrelated tools remain disabled. See
  [activation evidence](cloudflare-native-manager-activation-0398.json).
- Live integration found a defect: project open succeeded, but the single task-start
  request returned `409 repository_policy_enrollment_revoked`. Read-only database checks
  found no policy, intent or task. This is not evidence of an actual revoked enrollment;
  ordinary task start enrolls the deployment-selected policy inside a transaction.
  A mixed Prisma runtime reproduction showed nested SQL fragments can become ordinary
  parameters. The bounded fix assembles complete parameterized queries before crossing
  runtimes; live acceptance remains pending. The failed request is retained without replay.
- Browser preparation: reused the recorded Browser Testing workspace. Synthetic-only
  preparation passed; the updated Phase B harness binds the native origin and workspace
  together and enforces the cumulative native request ceiling. No native browser acceptance
  has run yet. The incremental ledger carries forward 31 requests and reserves new attempts
  durably, including failures and uncertain outcomes; the earlier 148-request scope is separate.
- Production implementation still needs the single-Worker release contract, explicit
  production request handling, coordinated schedules, deployment configuration/readback,
  retained production identities, database compatibility and rollback validation. An inactive
  parent Worker and a successful preview do not satisfy those gates. Production activation
  and the final merge remain the user's decisions.

### Single-Worker implementation and queued native task

- The mixed-runtime negative control reproduced the exact enrollment error. Complete-query
  assembly passed actual local Workerd enrollment/replay and joined queries, plus 12 focused
  PostgreSQL policy/epic tests. Commits `a045d68d` and `b22216f6` are published. The exact b222
  native build/proof and automatic Cloudflare deployment passed. A new bounded operator
  deployment passed effective-binding readback; the same six native secret values are retained.
- Live b222 task start now passes policy enrollment and acknowledges one durable intent. One
  explicit reconciliation wake returned a retry before any committed guardian runtime or
  manager registration. No second task was submitted. Node and offline Workerd identity checks
  pass; a real Workerd reservation callback also passes inside a forced rollback with zero
  scoped rows before and after. These probes do not identify the original live failure.
  [Task evidence](cloudflare-native-task-b22216f6.json) records the bounded result. Incremental
  outer requests: 42/200; manager/thread/browser acceptance remains pending.
- Single-Worker production code is committed at `86fef37a`: explicit production request gate,
  public-origin/session relay bounds, one five-minute schedule, and one attested physical
  artifact/promotion/recovery/metrics stream. The two-Worker legacy path remains supported.
  Native Preview release targets fail before production-version API calls. Validation includes
  67 relay/request tests, four composition tests, 20 publisher tests, 57 release unit tests and
  16 isolated PostgreSQL journal tests. Independent review findings were corrected. This is
  source/local-provider validation, not an account-backed production release or activation.
- Task status now records a fixed failure stage for request decoding, account/project/policy
  checks, workspace enrollment, host start/status and status persistence. No exception text,
  credentials or stacks are persisted. Existing session IDs survive retries and blocking;
  successful reconciliation clears the notice, and cancellation retains an uncertain claim.
  Both pending and blocked tasks show neutral notices without promising an automatic retry.
  Next: deploy this diagnostic candidate and reconcile the existing queued intent once.

### Identity validation checkpoint

- Published `00264a36` and `ff63b499` pass their exact local native Worker proofs and
  automatic Cloudflare builds. Effective bindings are checked after each bounded operator
  overlay; no production activation follows. The original request reached its normal
  preparation timeout while integration was investigated and remains recorded as blocked.
- The primary verified authenticated host journals, exact worker identity and database state
  before authorizing a distinct bounded request. This proves non-execution of the old request
  under the guarded admission protocol; it is not a whole-kernel quiescence or cleanup claim.
  Old intent `3f7b4ce4-eb01-52aa-adbb-f7d031e87206` is retained. New intent
  `033c3113-5847-58bf-ac7a-327a06fafc46` explicitly records its replacement relationship.
- The new request reaches the host identity response, then records
  `guardian_identity_validation`. There is still no guardian runtime, admission, registration
  or verified model turn. Finer fixed identity failure categories are implemented without
  changing the validation predicate. Clock behavior is a hypothesis, not an established cause;
  offline Workerd checks used captured time, while the earlier Node check used live time.
- Incremental outer requests are 51/200, including one second-precision HTTP clock observation.
  Native browser continuity, actual manager/subagent/publication and pre-admission recovery
  remain open gates. Replacing an independently verified unexecuted test request is not proof
  that the ordinary task-retry path recovers a request that never reached the host.

- The live granular check subsequently recorded `guardian_identity_future`: the received
  issuance time was later than the verifier's sampled clock. Cloudflare's
  [timer contract](https://developers.cloudflare.com/workers/runtime-apis/performance/)
  explains that time advances after I/O; the precise offset was not measured. The implementation
  now resamples through an abortable timer and may wait at most about one second for a small
  remaining difference. It never clamps time or accepts a timestamp still in the future.
  Original expiry, signed duration, nonce, signature, pins and process checks remain in place.
  Focused PostgreSQL tests cover frozen clocks, bounded waiting, continued-future rejection,
  invalid identity and cancellation, and independent review found no remaining issue.
  Actual remote enrollment after this fix remains to be validated.

### Retired compatibility Workers

The user directed removal of the four obsolete Workers. Fresh provider identity
checks matched each recorded name, tag and creation time; the jobs, app, auth and
capability Workers were removed without force in dependency order. Readback found
only the `hive` parent and retained native branch Preview; its production deployment
was unchanged. The [retirement receipt](cloudflare-single-worker-retirement.json)
records the identities and results. The Neon databases and R2 bucket remain intact.
Code and provider settings were privately archived, but write-only Worker secret
values could not be exported; retained compatibility data may therefore depend on
unrecoverable retired keys. This retirement does not prove native manager/browser
acceptance or authorize production cutover. Compatibility upload helpers refuse
live deployment; local build and proof workflows remain available.

## Enrollment acknowledgment recovery and current acceptance sequence

- Remote clock-fix validation reached a committed runtime enrollment on the native Preview;
  the host then held its pending enrollment because it did not retain the acknowledgment.
  No native admission, registration or model turn followed. This replaces the earlier
  hypothesis that identity verification alone still blocked the pilot.
- Future host packages now implement factual readback of that exact consumed enrollment,
  without changing its original authority deadline. Expired, untouched runtimes can close
  only through an explicit owner grant and actual native tree-exit receipt. Local installed
  host/PostgreSQL composition passes lost-ACK and expired-empty closure scenarios. Independent
  review caught stale enrollment-expiry gating after legitimate admissions, and a grant-expiry
  race during lock waits. Both are fixed with regressions that failed before their fixes;
  final independent review approves the slice. The primary reran 16 PostgreSQL/installed-host
  tests, 26 controller tests and five cron-composition tests; all pass, as do TypeScript and
  template/package synchronization. The host archive is 157,056 bytes under the 160,000-byte cap.
- The old `5390bdfc-b004-4489-96c8-2b9f1de20f1f` workspace is stopped and retained, with private
  journals and dedicated test authentication archived. This is operational quarantine, not
  proof of cryptographic tree closure or cleanup authorization. Database history remains.
  [Quarantine receipt](d11-native-flow-quarantine.json).
- Next: complete review and exact-source checks, publish one smoke-tested inactive preview
  image, provision a fresh isolated test host, then run the actual manager/child/acceptance/
  publication/closure path and Browser Testing acceptance against the same native deployment.
  Source-only cutover preparation proceeds independently; no production activation is authorized.

## 2026-11-06 implementation and real admission checkpoint

- Reviewed enrollment recovery is committed at `934298b1`; minute jobs routing at
  `95ff2710` and offline first-production preparation at `2f7a69fe`. A documentation-only
  formatting fix produces `83f273a1`; its unchanged application build hashes and actual
  assembled native Workerd proof pass. GitHub CI is green. The image from the identical
  host sources at `2f7a69fe` passed smoke/local-registry identity checks and was published
  once without changing a production image alias or globally active template.
- Fresh isolated host `3e2e5966-6b15-46e7-abde-f3fed711d360` verifies exact package/process,
  owner/build, private distinct PVC and managed dedicated-account Codex login. A reviewed
  branch-only operator deployment has exact variable/secret-name/R2 readback. One bounded
  task is accepted and one reconciliation wake completes enrollment and commits preparation
  admission. No native process or model turn starts: the host loses that preparation ACK,
  preserving its pending signed frame while the server is at generation two. See
  [real task receipt](cloudflare-native-task-83f273a1.json).
- This demonstrates that enrollment-only readback is insufficient. Generic atomic operation
  receipts and factual readback for prepare/checkout/native/fence are in implementation,
  with separate fresh execution authority, cumulative deadlines and staged blocked recovery
  still required. The already-held immutable package cannot be retrofitted or used to invent
  an old operation receipt. It is privately archived and stopped/retained; neither cryptographic
  closure nor cleanup is claimed. [Quarantine](d11-native-recovery-quarantine.json).
- Task reopen status is implemented at `e98c60f7`, moderate difficulty. Seventy project/UI tests
  pass. Newest intent selection precedes eligibility checks, preventing old blocked requests
  resurfacing after newer completed work. This reads status only; it does not retry a task.
- Portable terminal-agent event ingress/dispatch is implemented at `c17e2fcf`, high difficulty.
  Fifty-eight checks pass, including nineteen PostgreSQL checks and twelve actual Workerd
  checks. A reviewed lease-expiry race is fixed. `8f51610c` wires recurring CI coverage and
  runtime-role regrant checks. Migration 41 is applied only in isolated local fixtures;
  live Native/Neon still has forty migrations. Installer parity and actual browser push
  remain open, and all new live flags remain off. [Scope and evidence](agent-notifications.md).
- Preview placement is prepared at `4d99e556` for Neon in AWS us-east-1, verified against the
  installed Wrangler schema and official Preview configuration guidance. Nine deployment/
  preparation checks pass. It has not yet been published or measured. Placement mitigates
  latency; it does not replace durable recovery or guarantee acknowledgment deadlines.
- Current unpublished implementation checkpoints will be published together after the receipt
  protocol and installer changes settle, avoiding automatic Preview deployment churn during
  live acceptance. Production data, routes, schedules, template activation and final merge
  remain unchanged and require the owner's eventual cutover approval.

## 2026-11-06 Coder OAuth priority

The user explicitly requested implementing F09 now after observing the legacy
email/password form. This supersedes the earlier documentation-only deferral for
F09. Static confidential client configuration per deployment replaces dynamic
registration; the exact callback is `/api/auth/coder/callback`. The native Preview
UI must show Continue with Coder and return through real code/PKCE/browser-bound
state to a normal Hive session. The extra private Preview bearer/cookie gate was
separately removed at the user's request; ordinary application authentication and
owner checks remain.

The login presentation now reads server-only readiness on every request and never
serializes OAuth configuration. Enabled/misconfigured deployments do not fall back
to password collection. Focused UI/config and production-isolation checks pass
locally; backend, actual assembled Worker and dedicated-account Browser Testing
acceptance are separately recorded before any completion claim. Production
preparation strips Preview OAuth variables and keeps OAuth off pending a separate
production client/configuration and approved cutover. F10 in-app Codex/Claude
connections remains deferred roadmap scope. No OAuth live acceptance is claimed
by this source checkpoint.


## 2026-11-06 F09 Preview acceptance and current pilot state

- F09 Preview login/refresh checkpoint: accepted, moderate/high difficulty. Real Coder consent
  and code exchange on `70839d32` preserve the existing Hive identity and user/session mapping.
  Two concurrent requests after isolated Preview access expiry both authenticate, advance the
  stored credential by exactly one version, return refresh state to idle and use no managed-key
  fallback. Consumed callback replay is rejected without signing out the existing session.
  [Live OAuth receipt](coder-oauth-live-preview.json).
- Chrome caught a browser-only integration defect missed by HTTP checks: the GET form's
  cross-origin 303 was blocked by the existing `form-action 'self'` CSP. An entirely intercepted
  synthetic Chrome regression reproduces the form failure and native-anchor success with zero
  upstream requests. The `bfd4d88f` application uses a native anchor through the shared Button's
  supported render mode; CSP is unchanged. Browser Testing verifies the fixed Coder destination,
  no credential inputs, authenticated workspaces and reload. [Login screenshot](coder-oauth-login-preview.png)
  and [exact build proof](cloudflare-native-proof-bfd4d88f.json).
- Evidence boundary: provider consent/code exchange ran on the primary. Browser Testing then
  received only the Hive test-account application session for authenticated reload; no Coder
  management credential crossed into that workspace. This is not a continuously browser-driven
  provider-consent flow. Browser route counters exclude automatic redirect-chain requests;
  independently observed top-level Coder navigation does not establish a global egress count.
- Production OAuth preparation: independent client registration and explicit enrollment metadata
  support are ready. The helper pins the Coder issuer, production origin/callback, independent
  client ID and fifth required secret name, strips Preview OAuth variables and retains build,
  baseline and final-approval gates. [Enrollment receipt](coder-oauth-production-client.json)
  and [offline preparation](../../../deploy/cloudflare/native/production-preparation.md).
  No production route or OAuth login has been activated/accepted. Provider revocation/disconnect
  and final production acceptance remain their recorded gates; F10 remains deferred.
- Recovery implementation is no longer pending: generic atomic operation receipts/readback
  landed through `617f8cc8` and subsequent recovery fixes, with original authority deadlines preserved;
  explicit owner retry at `726ed4ee` is source/test reviewed. See
  [operation receipts](guardian-operation-receipts.md),
  [local operation recovery](guardian-operation-recovery-local/result.json) and
  [owner retry evidence](project-task-recovery-local/README.md). Earlier held hosts remain
  quarantined; missing historical receipts cannot be fabricated.
- The [`bfd4d88f` immutable image](host-preview-image-bfd4d88f.json) passed smoke and verified
  registry publication; global active template
  rollout remains unchanged. Both application/native Preview databases now have migration 44,
  preserved prior data/checksums and verified runtime privileges. The native missing-grant
  postflight finding was repaired at `cd9fb52b` without replaying migrations or changing data.
  [Migration and grant receipt](neon-preview-migration44.json). These scoped upgrade checks do
  not establish the full F08 cutover/restore acceptance gate.
- Next: verify the fresh isolated host, then run actual manager/child execution, source publication,
  independent semantic acceptance, factual closure and Browser Testing Phase B. F07/F08 parity,
  release behavior and the final production cutover remain unproven. OAuth Preview acceptance
  does not complete the delivery epic or authorize production activation.


## 2026-11-06 OAuth revocation deployment and startup gate

- `483737d0` adds fresh provider identity checks and atomic, generation-bound credential/session
  invalidation after definitive revocation. A delayed old rejection cannot erase a newer login;
  a new login cannot revive deleted old sessions. The scoped local checks include 41 PostgreSQL
  OAuth cases, 118 targeted checks and 192 auth checks. See the
  [local acceptance](coder-oauth-revocation-local.md).
- The exact source passed full GitHub CI, Cloudflare build, post-build TypeScript and actual
  assembled Workerd acceptance. Workers Builds automatically deployed that commit to the native
  branch Preview. Anonymous login shows Continue with Coder and no credential fields.
  [Deployment receipt](coder-oauth-revocation-deployment.json) and
  [runtime proof](cloudflare-native-proof-483737d0.json). Real-provider revocation/reconnect now passes separately; explicit disconnect remains open.
  [Live revocation and reconnect](coder-oauth-revocation-live-preview.json).
- The primary-created test host and task-created Infrastructure diagnostic host both report
  running builds but agents that never connected. Read-only Coder inspection confirms identities
  unchanged. The [startup record](d11-native-final-readonly-preflight.json),
  [Infrastructure creation record](native-startup-infrastructure-creation.json), and
  [bounded diagnostic result](native-startup-infrastructure/result.json) preserve this blocker.
  No cluster probe, host authentication transfer or enrollment occurred. The proposed
  [primary read-only probe](native-startup-infrastructure/primary-readonly-plan.md) awaits an
  explicit exception to the supplied workspace routing instruction; it grants no repair authority.
  Preserve the test host and active diagnostic receipt until the bounded task is resolved.
- A fresh main fetch still resolves to `1ace8774`, already included in the epic branch. No history
  rewriting, production activation or paid resource change was needed for this slice.

- F09 live revocation/reconnect: accepted on `483737d0`, moderate difficulty. One real
  exact-token revocation yielded Coder401. Hive marked that same credential generation reconnect
  and deleted both previous sessions. Same-owner reauthorization returned the version to idle
  at exactly version+1 with one new session; protected settings read, workspace page and reload
  pass. The unchanged original cookie still gets API401, and old sessions remain absent.
  Testing encountered an unclassified initial503 and two checker defects (CookieJar deepcopy
  and an incorrect page-redirect assumption); original failed receipts were preserved and the
  continuation never repeated revocation. See the [scoped live receipt](coder-oauth-revocation-live-preview.json).
  Explicit disconnect and production acceptance remain open; F10 remains deferred.
- Shared-session Browser Phase B harness now accepts a fixed-origin Hive session cookie for
  native OAuth deployments, blocks password/bootstrap calls and accepts the primary-created
  native-final target only as a registry identity. Nineteen local Node/Python checks and
  independent source review pass. No new Browser Phase B execution/host enrollment is claimed.

- Production metadata collector: source and real read-only capture accepted, moderate difficulty.
  Twenty-nine focused checks and independent review pass. A real two-sample, nineteen-GET capture
  validates fixed scope, public projection, strict pagination, nullable API settings/domain IDs
  and sanitized errors. The retained parent version is unchanged, with bootstrap-only bindings
  and no secrets/crons/Hive zone route/custom domain. Provider metadata reports parent workers.dev
  enabled, so the inactive-baseline conversion correctly holds; no setting was changed and no
  activation/rollback/health acceptance is implied. [Readback receipt](production-readback-live.json).

- F09 deployment-preview navigation: source correction validated after a Safari report.
  The deployment-specific host rejected its relative OAuth start with an empty400;
  the canonical branch start still redirected correctly. An absolute validated
  public start link and readable rejection headers/body fix future deployments
  while preserving origin/cookie/CSP checks. Twenty-two focused checks, full TypeScript
  and independent review pass. [Root cause and scoped validation](coder-oauth-preview-alias.md).

- F09 preview-host fix live: Cloudflare build and four bounded HTTP checks pass at
  `81e5e084`. Both stable and newly published deployment login pages link to the
  registered start origin; noncanonical starts return readable400/no flow cookie,
  and canonical starts redirect to the fixed Coder client/callback with S256.
  Existing immutable deployments retain prior code, so use the stable branch URL.
  [Live receipt](coder-oauth-preview-alias-live.json). No Safari automation claimed.

- Native Preview release identity foundation: implemented and accepted for read-only scope.
  The new reader and existing observer/controller seam use exact branch/Preview identity,
  bounded manual-redirect GETs and matching samples. Thirty-one focused checks, independent
  review and four real GET200 responses pass. Actual source/action annotations are absent;
  eligibility stays unverified. No source/build/artifact/config/health/effect authority or
  atomic CAS is inferred. Production mutation guards stay in place.
  [Source design](native-preview-release-identity.md) and [live receipt](native-preview-release-identity-live.json).
