# Connected Builds preview pilot

This is a preparation and acceptance plan, not a completed pilot or production authorization. Use the existing connected GitHub account, repository `kethalia/hive` (ID `1183966024`), and repository-connected Cloudflare Workers Builds pipeline for the single `hive` Worker. The reviewed epic branch is `codex/delivery-system-design`. Its Preview is separate from production; merging the epic and production cutover remain owner decisions.

## Preparation

1. Record the exact reviewed source commit, successful CI run and connected Builds deployment. Verify the actual Preview branch, fixed account/Worker, origin and deployed application build identity. Preserve the provider receipts and the reviewed public configuration. Do not infer serving identity from a successful build alone.
2. Verify the existing dedicated test user's Coder connection and the primary-recorded test workspace identity. Creation provenance remains immutable; use a separate primary-approved lifecycle/readiness record for its current build, template version, image and host epoch. Require fresh authenticated readiness and the enrolled package/source pins before enabling the bounded pilot. Preserve held attempts and their evidence.
3. Review the existing source/repository policies, allowed application paths, reviewer/check selectors, acceptance producer and target authority. Unknown paths and database changes remain out of scope until their separate D10 authority is enrolled. Independent review must use an identity permitted by the enrolled policy; a user's approval of their own PR does not establish independent review.
4. Keep the tested-tree workflow pinned to an exact reachable source commit and the digest of that commit's workflow and attestor bytes. Candidate tests remain unprivileged. The protected attestor uses its existing purpose-bound GitHub OIDC contract; attestation remains disabled until the owner enrolls the reviewed producer. No private Preview bearer, custom uploader, publisher environment or new deployment token is part of this plan.
5. Check that the actual task/release entry path and required observations are enabled for the reviewed Preview only. Native Previews have no cron in the current deployment contract; use the existing bounded authenticated task/status wake where supported. Do not substitute a different publication path to make a check pass. Missing authority, observations or independent review is a recorded hold.

## First task and browser validation

Run one bounded application task through the installed Hive manager using the reviewed one-use pilot plan. Keep future source, app-build and host-epoch pins unset until installation has been independently verified. Record durable mutation intents before calls; reconcile an uncertain acknowledgement by reading existing state, without issuing a duplicate mutation.

Track the real task, project and thread IDs, every completed step's report/event/attempt/source IDs, review/check results and semantic acceptance evidence. The existing connected Builds integration publishes branch commits. Observe the resulting deployment and fixed-origin app/auth/database readiness against the exact source/build; a green platform health response alone cannot establish arbitrary feature behavior or complete a production acceptance step.

Use the existing Browser Testing workspace for Phase B. Open Conversation and Terminal against the same actual host session/thread, verify the marker turn and event ordering after reconnect, and follow a completed-step notice to its exact report. Record both mobile and desktop results. Preserve screenshots and receipts in the primary workspace. Do not submit another task, send terminal commands or sign out the operator merely to exercise the views.

Close the task only after its required phase-specific independent acceptance succeeds and the existing guardian, writer, preservation and release fences permit closure. Start a second task only after inspecting the first task's outcome and confirming the workspace's current authority. A direct PR, seeded provider response, build success or screenshot alone is not an end-to-end result.

## Production boundary

Production release uses the existing repository-connected Builds production command after the owner's explicit cutover approval and reviewed production configuration. This Preview plan does not enable production, change routing, enroll production credentials or authorize a main merge. Production needs its own current source/build observations and independent semantic acceptance; Preview evidence cannot stand in for them.

Historical November 5 setup observations are retained in the D09 checkpoint and Git history. They are not instructions to provision old publisher resources or evidence of current access. If an existing connection lacks a required capability, record the precise failed read and continue independent work; do not create another publisher or credential system.
