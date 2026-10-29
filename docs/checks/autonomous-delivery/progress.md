# Autonomous delivery epic execution ledger

Updated: 2026-10-29. Status: implementation in progress, not release-ready.
Branch: `codex/delivery-system-design`.

## Authorization and boundaries

The owner authorized autonomous implementation, trusted subagents, isolated preview validation,
and a completed PR for their merge and production cutover approval. Use free tiers only; ask
before adding costs. Do not change production, merge the final PR to main, rewrite history,
or delete unrelated resources. Credentials stay outside source control and evidence.

## Current work

| Task | State | Evidence / next action |
| --- | --- | --- |
| Released baseline | Complete | PR #401 merged main into epic through GitHub; pulled 4d8b821. Formatting-only conflict resolved. |
| F01 fixed Coder host | Implemented; preview acceptance pending | 9cd5005 removes host input and enforces configured origin across login/session/terminal boundaries. Service and web tests pass. 98cf4e9 preserves redirect rejection using Workers-compatible fetch. |
| F02 Cloudflare/Neon | Clean app/auth runtime proof passed; guarded preview pending | Actual OpenNext app and auth service binding passed against restricted Neon runtime role at 4c0eedf. Provenance-safe auth rotation committed 6ae325d; exact latest preview build and baseline compatibility remain. |
| F03 project discovery | Signed gateway transport implemented; project enrollment pending | b0e278c ports discovery to verified Coder app transport, independently binds owner/build/app and uses agent-scoped GitHub access. No SSH fallback in Workers. Project enrollment and task-start integration remain. |
| F04 same native session | Native proof and durable registration passed; UI integration pending | b0e278c persists host lifetime and thread bindings, reauthorizes capabilities and recovers exact lost heartbeat acknowledgements. Real account-backed inference and deployed Conversation/Terminal mounting remain. |
| F05/F06 checkout lifecycle | Local supervisor and cleanup fences passed; installed composition pending | 35087ed fences cleanup against checkout reincarnation/inode reuse; test workspace native proof passes. Production cleanup authority remains disabled. |
| D02/D03 persistence | Foundation and recovery validated | 7a0b3da adds failed/expired attempts, source revision invalidation and reconciliation. b0e278c serializes manager mutations with registration replacement/revocation; real PostgreSQL CI includes manager and registration regressions. |
| D05 Delivery window | Initial read-only view validated | 5f7d3a5: owner-scoped task reads, latest and exact historic report links, native window reuse. 77 focused checks and synthetic desktop/mobile Chrome tests pass. Manager linking, pause UI, integrated deployment remain. |
| D07/D08 eligibility | Pure observation gate implemented | 25 focused tests pass, including delayed old runs, producer binding and current revision. Live authoritative adapters remain. Main currently has no required successful checks. |
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
  Created and verified the isolated persistent test workspace. Account-backed Codex testing still
  needs a fresh device login; the previous device code expired without completing authentication.

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
