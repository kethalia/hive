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
| F02 Cloudflare/Neon | Clean build and local auth/database proof passed; integrated app pending | e711046 deployed to isolated Worker: Coder identity, Neon HTTP and Prisma interactive transactions, duplicate replay and rollback passed. Public serving now disabled. fbafe43 clean actual Next/OpenNext build and workerd SSR pass; 6384511 Fetch auth Worker plus real Neon session/transaction/owner checks pass. Actual app service binding and terminal migration remain. |
| F03 project discovery | Partial implementation | 90e646a adds agent-scoped GitHub pagination and flag-gated Projects window. Primary account discovery tested without clones. Durable project/session association remains. |
| F04 same native session | Bounded proof passed; integration pending | CLI 0.165.0, tmux and two structured clients share one thread. Authenticated read bridge, renewal/replay fencing and browser transport implemented. Production host registration and project mounting remain. |
| F05/F06 checkout lifecycle | Supervisor integrated locally; CI follow-up in progress | e3a196e preserves native thread history after checkout removal and gates execution on a verified lease. CI exposed stale cleanup authority after rehydration; incarnation fix underway. Production cleanup authority remains disabled. |
| D02/D03 persistence | Foundation validated; recovery in progress | d56d6a1: 30 domain/PostgreSQL checks, fresh/upgrade data preservation, restart replay with one report/outbox, immutable evidence. Explicit failure/expiry/source-change reconciliation next. |
| D05 Delivery window | Initial read-only view validated | 5f7d3a5: owner-scoped task reads, latest and exact historic report links, native window reuse. 77 focused checks and synthetic desktop/mobile Chrome tests pass. Manager linking, pause UI, integrated deployment remain. |
| D07/D08 eligibility | Pure observation gate implemented | 25 focused tests pass, including delayed old runs, producer binding and current revision. Live authoritative adapters remain. Main currently has no required successful checks. |
| Test workspace | Created and healthy | User reconnected GitHub; verified valid. codex/hive-epic-test is running, agent connected and ready; two-hour autostop. Identity is preserved in test-workspace-creation.json. No primary credentials copied. |
| D06 durable notices | Persistence/claim slice validated; transport pending | Seven actual PostgreSQL checks cover owner isolation, competing consumers, stale acknowledgement, bounded retry/exhaustion, historical revision and non-report notices. Delivery shows recent activity; push transport/consumer integration remains. |
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
- Test workspace preparation: blocked, moderate difficulty. Template requires valid external
  GitHub authentication; account link exists but expired and cannot refresh. No bypass or
  credential substitution attempted. Other work continues.

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
