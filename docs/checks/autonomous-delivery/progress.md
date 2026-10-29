# Autonomous delivery epic execution ledger

Updated: 2026-10-29. Status: implementation in progress, not release-ready.
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
| F01 fixed Coder host | Implemented; preview acceptance pending | 9cd5005 removes host input and enforces configured origin across login/session/terminal boundaries. Service and web tests pass. 98cf4e9 preserves redirect rejection using Workers-compatible fetch. |
| F02 Cloudflare/Neon | Guarded preview passed; updated candidate pending | Actual app/auth preview passed at b80a3e1; both public URLs are now disabled. Nineteen isolated Neon migrations are applied. Sustained local relay proof passed at 1107907. Updated native-callback candidate and baseline compatibility remain. |
| F03 project discovery | Signed discovery and project enrollment implemented; preview pending | b0e278c ports discovery to verified Coder app transport, independently binds owner/build/app and uses agent-scoped GitHub access. No SSH fallback in Workers. 7635164 adds stable enrollment and durable first-task preparation; account-backed preview remains. |
| F04 same native session | Real-account delegation passed; deployed browser acceptance pending | d10cc02 preserves the actual Sol/low manager and child pilot. Native WS/CLI/history proofs and mounted views pass their bounded tests. Deployed browser attachment and authenticated conversation interaction remain. |
| F05/F06 checkout lifecycle | Local supervisor, renewal and template packaging passed; deployed acceptance pending | bada7bd renews dirty live leases and revokes expired tasks across controller phases. 4d5f703 packages the host in opt-in templates; 5698da6 adds proven pre-execution retry. Production cleanup authority remains disabled. |
| D02/D03 persistence | Foundation and recovery validated | 7a0b3da adds failed/expired attempts, source revision invalidation and reconciliation. b0e278c serializes manager mutations with registration replacement/revocation; real PostgreSQL CI includes manager and registration regressions. |
| D05 Delivery window | Initial read-only view validated | 5f7d3a5: owner-scoped task reads, latest and exact historic report links, native window reuse. 77 focused checks and synthetic desktop/mobile Chrome tests pass. Manager linking, pause UI, integrated deployment remain. |
| D07/D08 eligibility | Signed transport and manager policy integration passed locally; live composition pending | 8571cd1 binds result references to the exact PR, checkout and full controller policy; 92 focused checks pass, including real PostgreSQL races. a4fa338 preserves pending retry bytes while retiring validated expired records. Live R2 retention/integrity passed; cleanup is complete. Installed source composition remains. GitHub reports no required PR checks. |
| Test workspace | Created and healthy | User reconnected GitHub; verified valid. codex/hive-epic-test is running, agent connected and ready; two-hour autostop. Identity is preserved in test-workspace-creation.json. No primary credentials copied. |
| D06 durable notices | Dispatch implemented and local Worker crypto/transport proof passed | 1307b4c bounds durable claims, owner fanout, retry/exhaustion and preserves reports independently of push. Worker jobs have no cron/public endpoint and remain disabled. Actual scheduled delivery to a browser remains. |
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
  production acceptance. A missing `rg` command was handled by the child using `ls`; its pinned
  PATH integration remains a follow-up. Initial startup/test failures are preserved.
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
