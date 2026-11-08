# Unstarted metadata reservation recovery — proposed contract

The verified failure is a five-second supervisor wait around a guardian operation
whose existing controller/outer/wire budgets are 20/23/25 seconds. The supervisor
will use the existing bounded outer allowance and validate the approval's current
binding and authority deadline immediately before entering the runtime factory.
Timeout or cancellation retains an unknown reservation; neither may start late.

Recovery is restricted to one exact blocked prepared task with both native-create
and first-prompt-attempt flags false, no thread or terminal, no source application
or pending recovery, and a verified unchanged checkout/lease/source. The old HMAC
supervisor must be `starting`, `metadataLaunch.phase=reservationRequested`, with
zero projects and null native process/execution identity. `reserved` is rejected:
spawn could have happened before recording an identity. The old signed guardian
must have the matching completed launch response, exact admission inventory and
no pending operation/hold. Server runtime scope, launch ID/digest and absence of
registration/producer/thread facts must independently match. No generic absence
of processes or expired authority is accepted as proof of never launching.

A reviewed new image may activate only after the old process identities are dead
and the existing guardian/controller/supervisor locks are exclusively available.
Its constructor verifies the saved old config/package scope and all old journals,
then writes append-only retirement/transfer history before archiving those exact
journals. This retires unused authorization only: no ECHILD, tree-closure, writer
release, checkout cleanup or task completion is claimed. It exposes the same task
as blocked in a recovery-held new epoch, with original task/request/prompt/lease
and all old authority retained as history. Normal admission and new task/prompt
submission remain denied until owner recovery consumes its exact transfer.

Use the existing owner retry → guardian identity/provision → signed inspection →
authorization → consume sequence. The identity/provision evidence carries the
bounded retirement proof. A server transaction may retire the old runtime only
for the exact active owner recovery record and corroborated unused-reservation
facts, then fresh-enroll the new build. Inspection and consumption recheck current
policy, source, lease, journal fingerprints and new identity. Consumption creates
fresh preparation/launch authority for the same intent; old authority is never
transplanted. Concurrent or ambiguous recovery holds, and immutable replay cannot
issue a second reservation or first prompt.

Necessary schema decision before recovery implementation: the current runtime
phase CHECK, transition trigger and unique live-slot index allow only `reserved`,
`open`, `barrier_closed`, `tree_closed`. The old nonempty open runtime cannot be
replaced, and `tree_closed` requires actual tree-exit evidence. An honest terminal
`authorization_retired` phase therefore needs a narrow forward migration and an
append-only authenticated retirement event, with exact no-native server checks.
It must preserve native-launch fields and original receipts forever. No new table,
endpoint, service, publisher or immutable database-workflow pin is proposed.

Proposed source ownership: supervisor/budget tests; existing outer guardian startup
and project/supervisor retirement helpers; project recovery/controller contracts;
existing guardian identity/provision/store and owner retry flow; narrow forward SQL
constraint/transition/index update; composed local PostgreSQL and host-journal
recovery tests. No installed or live state changes occur during implementation.

## Activation and transaction ordering for review

1. Ship migration 51 and compatible server readers first. Recovery stays disabled
   until the reviewed host package is explicitly enrolled. The application and its
   controller DB role retain the existing trust boundary: owner session, Coder
   ownership/current build, signatures and package provenance are authenticated in
   the existing owner/provision code. SQL is defense in depth for exact structural
   prerequisites, not cryptographic protection against a compromised controller DB
   role forging every prerequisite row. No new key, service or extension is added.
2. On a normal owner stop/start into the reviewed image, capture all predecessor
   raw bytes BEFORE invoking any project/supervisor/controller initializer. Verify
   saved old public config by its original startup hash, known predecessor package
   and exact supervisor/control-flow compatibility, outer HMAC, controller signature
   against its attributed old public key, project/supervisor HMACs, and exact same
   owner/workspace/project/task/request/source/lease/admission/launch inventory.
   Current and archived files must agree; any later `reserved`/`started`, native,
   thread, prompt, pending, hold, conflicting transfer or unknown source holds.
   Verify old outer/guardian/worker identities are dead by boot/PID/start identity;
   inaccessible identities hold. Server later corroborates the previous Coder build
   is stopped and the exact successor is current. Keep the existing lock inodes
   exclusively held across snapshot, archive publication and successor activation.
3. Write one immutable transfer intent bound to old raw hashes, old/new bindings,
   target package and a unique transfer ID, then fsync exact predecessor archives.
   Retain every old receipt and private verification key in protected history. Only
   after complete archives and a retirement fact are durable may active files be
   advanced. The successor publishes a fresh startup identity but carries the same
   original task as recovery-held, not runnable. Old preparation/admission/launch
   objects remain historical and cannot authorize work. No checkout/lease cache is
   reset or removed. Crash replay resumes only this exact transfer from verified
   archives; contradictory source or destination files hold. Unfinished transfers
   never pass ordinary admission, clone preparation or first-prompt paths.
4. Existing owner retry creates its normal immutable recovery scope first. Its
   provision call receives the bounded transfer proof through existing identity
   evidence. Under slot → old runtime → complete admission inventory → intent →
   recovery locks, verify exact still-blocked intent version, owner recovery request,
   current successor identity/package and old completed launch. Require zero producer,
   registration, thread, source-application or competing recovery facts, no unknown
   external effects, and unchanged old launch and raw proof digests. Persist one
   authenticated retirement event and transition only phase to
   `authorization_retired` in the same transaction. The terminal phase is immutable;
   generation, old launch fields, enrollment, authority and receipts remain history.
   SQL independently checks every prerequisite, rejects NULL/missing/mismatched
   payload fields, and forbids direct transition without the exact event/recovery.
   It excludes only this proven unused runtime from live-slot occupancy; writer,
   lease, checkout, cleanup and actual tree-closure gates retain their old meaning.
5. Fresh enrollment of the new build uses existing grants and nonces. Signed owner
   inspection accepts the transferred task only with the matching server retirement
   readback and immutable local proof; it does not require opening a native runtime.
   Authorization rechecks current policy/source/lease and exact inspection/version.
   Consume retires active references to old authority into history, then prepares
   and reserves fresh authority for the same task through the existing paths. The
   original prompt and attempt flags are unchanged; no first prompt is resubmitted.
   Event/transfer uniqueness and transaction locks allow one successor/recovery.

## Deadline and adversarial checks

The metadata-specific caller allowance derives from existing 20/23/25-second
budgets. A latched timeout/cancellation must cover queue time as well as execution;
late approval may be retained as history but can never invoke the runtime factory.
The fresh launch response must expose a server-bound authority deadline, capped by
runtime/admission/policy freshness, and that exact deadline/cancellation is checked
after validation and durable reservation save immediately before factory entry.
No unrelated timeout or server proof lifetime is widened.

Tests must include delayed valid approval, expiry/cancel after approval/save,
late completion and concurrent open/recovery; `reserved` before identity recording;
wrong/unknown old package/config/key/build and rollback/contradictory archives;
inaccessible or live old identities; direct SQL phase changes and synthetic/null
retirement events lacking a legitimately established owner recovery; concurrent
registration/late launch/scope drift; crashes before/after each archive/event/phase
boundary; and exact old-state transfer with one successor and at most one original
first prompt. No success may imply writer release, cleanup or native tree closure.
