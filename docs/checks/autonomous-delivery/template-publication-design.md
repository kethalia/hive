# Portable template publication foundation

This document records the schema-27 checkpoint. [Schema-28 first creation and tag parity](template-publication-creation.md) extends it and corrects the initial investigation: Coder already reuses existing variables server-side, while Hive's stdin CLI path deliberately skips README metadata updates. The earlier followup list below describes the checkpoint's investigation state, not a requirement to add secret copying or new metadata behavior.

This slice replaces the Cloudflare path for an owner-requested publication of an **existing** maintained template. Node continues using the existing CLI/BullMQ adapter. Deployment, wake-up scheduling and remote provider effects remain disabled. First template creation, variable-prompt/reuse and README metadata parity, and authenticated detailed-log viewing remain required F07 followups.

The public, unauthenticated build-info read on 2026-10-30 returned `v2.38.4+d16b1ca`. The adapter targets the documented file/template endpoints and checks the corresponding v2.38.4 SDK/server behavior. No authenticated provider mutation was used for this investigation.

## Authority and artifact boundary

The browser supplies only a known catalog name and an optional bounded request UUID. The server binds Hive owner, current actor session and Coder user, fixed Coder origin, resolved default organization and existing template identity, and the maintained build artifact manifest. There are no caller URLs, Terraform bytes, secrets, organization IDs or activation policy fields.

The actor authorizer uses the existing authentication-service session/token operations. Each bounded provider step captures one credential, verifies its Coder subject and template-update permission, and rechecks the actor session. Jobs need no encryption key or copied personal credential. Current credential bytes never enter job/event rows. Logout or changed ownership blocks further effects; abort cannot undo an already in-flight provider request.

The archive loader accepts an ASSETS binding, uses a fixed digest-derived internal asset path, and verifies exact bytes, length and SHA-256 against the selected committed manifest entry. A queued job keeps its original artifact identity; a new deployment must not silently substitute different bytes. Missing or changed artifacts hold the job.

## Durable stages and uncertainty

Three additive models implement a globally serialized remote template target; an owner/session-bound publication job with immutable artifact/remote identity and lease fences; and an owner/job-scoped bounded progress journal. The remote target serializes publishers across Hive users. A conflicting active job returns a conflict rather than racing another version into production. Known identical active work is deduplicated; an explicit UUID `Idempotency-Key` binds exact owner/session/artifact/target retries.

The stages are preflight, file upload/readback, version creation/reconciliation, import polling, activation/readback, and terminal success/failure/hold. A stage records its intended remote effect before sending the request. Expired leases never erase unresolved effects or authorize a stale worker to advance a job. Each state mutation revalidates actor, target generation and lease under database locks.

Coder deduplicates identical uploaded bytes by their SHA-256 and creator. Thus an exact upload can be retried under the same verified actor and then downloaded for independent digest verification. An existing template's version name is unique, so `hive-<job UUID>` plus the fixed job/artifact marker permits scoped reconciliation after a lost create response. A missing readback after an unknown create never authorizes another blind POST. An adopted version must match organization, template, name, creator, initiating user, file, import job and artifact bytes.

Only a successful import can enter activation. The current remote template and selected artifact are rechecked. The normal successful path activates the verified version as the CLI does. An ambiguous activation permanently holds that target for explicit reconciliation; observing the desired active version is a fact, not permission to resend a PATCH or start a newer publisher.

The pinned Coder activation endpoint has no expected-active-version compare-and-set. Hive serialization and a fresh external-drift check protect its own dispatches, but cannot atomically fence an uncoordinated external CLI publisher. Activation readiness must acknowledge this upstream limitation; this foundation never claims stronger remote serialization.

## Progress and runtime seam

The job journal contains controller-owned stage labels and bounded provider log metadata/status/error enums. Raw Terraform/provisioner output may contain unknown secrets and is never persisted, emitted to an agent, or logged by this adapter. A fixed, identity-verified Coder version link preserves access to detailed output in Coder. Full raw-log parity needs a separately reviewed authenticated viewer.

The existing POST and SSE routes select the portable path explicitly for Cloudflare and retain Node behavior otherwise. Portable POST requires session authentication and same-origin CSRF checks. Reads bind owner, template name and job ID and revalidate the session during bounded SSE polling. The journal replays stable ordered progress after reconnect. Provider progress bodies, request duration, artifact size, event count and retry attempts are bounded.

The processor exposes an internal wake-up seam for the separately owned jobs Worker and an ASSETS loader seam for the application Worker. No cron, HTTP scheduler control, Cloudflare resource, application gate or packaging change is part of this slice. Local PostgreSQL tests use a separate schema-27 fixture; provider calls are explicit doubles.

`TemplatePublicationService.processOne()` performs one stage per wake. `processTemplatePublications(service, {maximum})` caps a caller's batch at two stages; the jobs adapter chooses one. The processor requires an injected AUTH_SERVICE authorizer and canonical ASSETS loader, not an owner credential or encryption key. `HIVE_TEMPLATE_PUBLICATION_ENABLED` defaults false. HTTP dispatch switches only when `HIVE_RUNTIME_TARGET=cloudflare`; the Node adapters retain their existing queue and CLI behavior.

Limits are 1 MiB archive, 256 KiB provider JSON, 4,096 body chunks, 10 seconds per provider request, 60 seconds per processor invocation, a 90-second claim lease, 256 immutable events, 1,000 log records per poll, five transient-error attempts with bounded backoff, and 15 minutes for import. Browser setup awaits race a 10-second deadline and request abort. SSE replays the complete bounded journal and its body races a 25-second deadline, including stalled auth/DB polling, for normal client reconnect. Timed-out underlying operations remain attached to the request's `waitUntil` lifetime until they settle; returning a timeout does not claim to cancel upstream work. Session and User identity rows are locked during local acceptance and actor/lease clocks checked after writes before commit. Bounded transaction retries include Prisma P2034 and the known raw-SQL serialization shape P2010/SQLSTATE40001 only. A request already sent to Coder can still complete after lease loss or logout; the durable uncertainty marker prevents activation replay or target takeover. No distributed lease is claimed to cancel upstream effects.

Unknown activation, missing ambiguous version readback, artifact drift, revocation and identity mismatch hold the target for explicit reconciliation. This slice intentionally exposes no automatic unhold/delete/history-rewrite operation. External Coder activity and credential revocation cannot be made atomic with Hive's transaction. These limitations, first creation, required-variable reuse, README metadata and detailed-log viewing must be resolved or explicitly accepted before F07 parity/cutover; the foundation is not that cutover.

## Local validation

Evidence is under `template-publication-local/`. The isolated fixture uses PostgreSQL 17 on a new local port, separate from retained schemas 25 and 26. Fresh migration and a copied populated schema-26 upgrade preserve all 35 existing tables byte-for-byte by sorted-row digest. Only the three publication tables are added. No Neon, Coder or GitHub mutation was made. Provider doubles test staged publication, lost creation and activation ACKs, foreign owner access, concurrent claims, logout during upload, changed artifacts, wrong import identity, external active-version drift, immutable history, safe SSE replay, and a real SQL sleep that expires a claim before acknowledgement.

## Primary evidence

- [Coder file API](https://coder.com/docs/reference/api/files) and [pinned deduplication implementation](https://github.com/coder/coder/blob/v2.38.4/coderd/files.go).
- [Coder template API](https://coder.com/docs/reference/api/templates), [pinned version/create/activation implementation](https://github.com/coder/coder/blob/v2.38.4/coderd/templateversions.go), and [unconditional active-version SQL](https://github.com/coder/coder/blob/v2.38.4/coderd/database/queries/templates.sql).
- [Pinned CLI push behavior](https://github.com/coder/coder/blob/v2.38.4/cli/templatepush.go), including initial creation, default activation, variable handling and optional README metadata updates.
