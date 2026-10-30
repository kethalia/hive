# Independent guardian admission: proposed installed contract

Status: proposal for the next default-off slice, not implemented authority. Migration `20261029130000` is reserved. Native registration semantics stay unchanged. Local controller HMAC journals and guardian ECHILD receipts are evidence inputs; neither grants server execution, source publication or cleanup authority.

## Bootstrap without a native thread

The authenticated project controller first resolves the current owner/Coder workspace/agent/build/app through the existing server-owned Coder client and owner-only app-cookie transport. It fetches a fixed guardian identity endpoint from that exact app. The worker obtains only public identity metadata from its private outer channel: outer public key, guardian lifetime, runtime binding digest, exact package/ELF/Node/config digests and startup attestation identity. No browser or model chooses these fields.

The server compares deployment-approved package/ELF/Node/policy digests and the verified Coder binding. It issues a 60-second one-use `workspace:guardian:enroll` grant bound to that exact public key/lifetime/build/app and a server runtime UUID. The grant is delivered through a fixed owner-only app bootstrap endpoint, then forwarded to the outer through FD3. The outer signs the grant digest and exact enrollment body with its separately protected Ed25519 key. Fixed POST `/api/codex-host/guardians/enroll` verifies issuer grant, outer proof, current owner/Coder binding and one-use server grant state in one transaction. Replays cannot bind another key or lifetime.

The runtime is now enrolled for preparation, not registered native execution. It may not replace or adopt an unresolved previous guardian lifetime. Expired metadata never proves an earlier tree exited. A fresh pilot workspace avoids pretending that legacy untracked runtimes have been reconciled.

## Preparation, finalization and fresh fences

Before the first task helper/Git spawn, the outer requests project admission using the controller's immutable preparation digest and task scope. The server locks the owner/workspace slot, runtime and project admission, then the persisted `ProjectTaskIntent`. It independently checks project/repository/provider account, request identity and base SHA, current owner/build/app, approved runtime profile and OPEN generation. The initial admission contains no predicted lease or native registration.

After preparation, a separate immutable finalization pins the actual lease ID/generation and checkout incarnation. Native root creation is permitted only after the server has accepted that final checkout binding under the preparation admission. Once the existing native registration has been redeemed, an additional exact binding attaches its registration ID, server instance and registered project/root thread before first prompt or producer operations. Finalization never rewrites the preparation digest or physical base revision. This ordering resolves the bootstrap cycle without treating an unregistered root as a source producer.

Signed fixed-action fence requests revalidate current persisted state and owner/Coder authority. The proposed preparation/fence authority lease is 180 seconds (bounded helper timeout is 120 seconds); expiry blocks further work and preserves holds. Native registration retains its own shorter heartbeat expiry. A fresh fence returns current runtime/admission generations; historical replay receipts are not current execution authority. Unknown writes, lost registration/finalization ACKs or conflicting incarnations hold until explicit authoritative reconciliation.

## Store and shared producer lock

Proposed tenant-bound rows:

- `GuardianEnrollmentGrant`: exact server-approved bootstrap binding/digests, token digest, expiry and one-use consumption.
- `GuardianRuntime`: slot, outer key, lifetime/binding/package identities, monotonic generation, authority lease, phase and current closed barrier. One unresolved runtime per slot.
- `GuardianProjectAdmission`: immutable preparation tuple/digest, admission generation and separate immutable checkout/native finalization records. One incarnation per project per runtime.
- `GuardianClosedBarrier`: unique expected runtime generation and full ownership-set digest, requested/closed timestamps and immutable exact request digest.
- `GuardianStopDecision`: one decision per barrier/admission, pinned current task/attempt/source/lease/native sequence and allowed/held reason. No model-supplied stop boolean.

All producer paths use `lockProducerAdmission(tx, scope)` before checkout/intent/task locks. Lock order: slot/registration → runtime → project admission → preparation intent → manager binding → task/attempt. It derives Coder owner from persisted User/slot, verifies current registered project/root, approved finalized producer, exact lease/incarnation and OPEN generation. It returns persisted runtime/admission IDs and generations, producer digest, checkout incarnation and barrier generation. Bootstrap/preparation rows cannot pass this lock.

The source issuer's early `authority.lockTransaction(tx,{publication,proofDigest})` acquires these locks before `lockManagerCheckout`. Its later authority callback performs only nonce/grant/proof CAS under those already-held locks. Source context/cursor/native sequence remain separately pinned by existing source/progression services.

## Closing the shared lifetime

A signed outer drain request names the exact current generation and full admitted set. The server independently resolves every current project/task/lease/producer state. Any active, preparing, unknown, unresolved external effect or missing project decision defers the entire elective drain. Passing policy persists the closed generation and per-project stop decisions transactionally under the same producer locks; no subsequent admission or effect grant may pass. The response is a bounded signed/transport-authenticated stop decision, not an ECHILD receipt.

The outer journals this decision, closes inner input admission, obtains the exact durable worker barrier ACK, then drains the guardian-owned tree. Only afterwards may a separate server receipt-ingestion contract evaluate a challenge-bound ECHILD receipt. External producer reconciliation, releasing physical writer anchors, `quiescedAt`, checkout cleanup and replacement runtime admission remain separate gates. No public activation, resource creation or cloud calls are part of this implementation slice.

## Implementation order and proof

First review the wire/schema above, especially the three preparation/checkout/native stages and deployment-approved package pin source. Then implement storage plus local PostgreSQL concurrency tests, fixed signed default-off routes, and the outer factory/owner bootstrap delivery. Compose the real server store with the existing actual isolated guardian/native mock fixture. Required negatives include forged owner/package/key, consumed grant, unresolved old lifetime, preparing/active sibling drain, slot replacement, registration expiry, same-project changed incarnation, closure racing source grant and late ACK. Only after that checkpoint should installer activation be considered.
