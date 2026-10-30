# Autonomous delivery epic execution ledger

Updated: 2026-10-30. Status: implementation in progress, not release-ready.
Branch: `codex/delivery-system-design`.

## Authorization and boundaries

The owner authorized autonomous implementation, trusted subagents, isolated preview validation,
and a completed PR for their merge and production cutover approval. Use free tiers by default; ask before adding costs. The owner separately authorized the
bounded R2 proof and up to one GB if needed; its actual payload is 117 bytes. Do not change production, merge the final PR to main, rewrite history,
or delete unrelated resources. Credentials stay outside source control and evidence.

## Current work

| Task | State | Evidence / next action |
| --- | --- | --- |
| Released baseline | Complete | PR #401 merged main into epic through GitHub; pulled 4d8b821. Formatting-only conflict resolved. |
| F01 fixed Coder host | Real preview login passed; full expiry/owner scenarios remain | 9cd5005 removes host input and enforces configured origin across login/session/terminal boundaries. Service and web tests pass. 98cf4e9 preserves redirect rejection using Workers-compatible fetch. |
| F02 Cloudflare/Neon | Updated preview login/logout passed; baseline parity pending | Source106721d remote hashes and local23 checks pass. Hydration-aware browser run verifies login, secure cookies, desktop/mobile overflow, API logout and stale-cookie401. Both URLs are disabled;54requests total including preserved first failure. Local full-Next workerd on9a0a556 passes auth and reviewed workspace action transport against isolated Neon. Preview schema26 preserves all31 prior table hashes; Settings UI/full baseline parity pending. |
| F03 project discovery | Signed discovery and project enrollment implemented; preview pending | b0e278c ports discovery to verified Coder app transport, independently binds owner/build/app and uses agent-scoped GitHub access. No SSH fallback in Workers. 7635164 adds stable enrollment and durable first-task preparation; account-backed preview remains. |
| F04 same native session | Real-account delegation passed; deployed browser acceptance pending | d10cc02 preserves the actual Sol/low manager and child pilot. Native WS/CLI/history proofs and mounted views pass their bounded tests. Deployed browser attachment and authenticated conversation interaction remain. |
| F05/F06 checkout lifecycle | Local supervisor, renewal and template packaging passed; deployed acceptance pending | bada7bd renews dirty live leases and revokes expired tasks across controller phases. 4d5f703 packages the host in opt-in templates; 5698da6 adds proven pre-execution retry. Production cleanup authority remains disabled. |
| D02/D03 persistence | Foundation, recovery and informational reports validated locally | 7a0b3da adds failed/expired attempts, source revision invalidation and reconciliation. b0e278c serializes manager mutations with registration replacement/revocation. 2e3c10e adds informational reported outcomes separate from verified acceptance, with two additive local migrations and PostgreSQL CI coverage. |
| D04 manager progression | Bounded native/PostgreSQL composition reviewed; installed acceptance pending | 69a868b advances three manager turns and two delegated steps with one held physical writer. All 76 focused native checks pass; expired registration and delayed-response review findings are fixed. Source advancement, runnable recovery, larger epics and interactive CLI coexistence remain gates. |
| D05 Delivery window | Reports, scheduling controls and manager navigation validated locally; deployed acceptance pending | 5f7d3a5: owner-scoped task reads, latest and exact historic report links, native window reuse. 77 focused checks and synthetic desktop/mobile Chrome tests pass. Owner pause/resume and exact manager Conversation/Terminal navigation now pass local checks; integrated deployed acceptance remains. |
| D07/D08 eligibility | Signed transport and manager policy integration passed locally; live composition pending | 8571cd1 binds result references to the exact PR, checkout and full controller policy; 92 focused checks pass, including real PostgreSQL races. a4fa338 preserves pending retry bytes while retiring validated expired records. Live R2 retention/integrity passed; cleanup is complete. Installed source composition remains. GitHub reports no required PR checks. |
| Test workspace | Created; last inspection healthy | User reconnected GitHub; verified valid. codex/hive-epic-test has a two-hour autostop and must be freshly inspected before the next installed pilot. Identity is preserved in test-workspace-creation.json. No primary credentials copied. |
| D06 durable notices | Dispatch implemented and local Worker crypto/transport proof passed | 1307b4c bounds durable claims, owner fanout, retry/exhaustion and preserves reports independently of push. Worker jobs have no cron/public endpoint and remain disabled. Actual scheduled delivery to a browser remains. |
| F07 background-service replacement | Credential scheduler and notices implemented disabled; other adapters pending | 1034cfe adds durable credential rotation, expiry outbox and schema26; parent tests pass. Template publishing/logs, generic terminals/files/voice, agent tools and hook adapters remain. |
| Remaining F/D tasks | Pending | Follow docs/autonomous-delivery-epic.md dependencies; no automatic release enabled. |

## Resource and cost record

Neon preview is a separate Free project (`purple-math-59583745`), with no production data copied.
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

1. Package the pinned host runtime and signed project enrollment/task-start path; activate only an
   inactive preview template version in the recorded test workspace.
2. Connect the project Conversation/Terminal views to the registered host and durable task notices.
3. Deploy the guarded exact application preview within a verified bounded included-usage budget;
   finish baseline Coder/terminal/settings compatibility and credential rotation scheduling.
4. Connect independently verified GitHub checks/reviews, native execution observations and release
   adapters. Keep production execution disabled pending owner cutover approval.
5. Run account-backed native and Browser Testing acceptance, migration/rollback rehearsal, failure
   recovery, full CI and independent review. Only then mark PR #402 ready for the owner to merge.

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
