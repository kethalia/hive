# Template first creation and inherited provisioner tags

Schema 28 extends the default-off schema-27 publisher with first creation and pinned active-version provisioner tags. The owner still supplies only a known maintained catalog name and optional request UUID. Actor/session, default organization, artifact, operation mode and remote identities are derived by the controller. No deployment, provider mutation, credential rotation, cron or cloud resource is authorized by the local tests.

## First creation

The fixed organization/catalog name is reserved globally before effects. Existing remote UUID uniqueness remains; a missing remote UUID may bind once, never clear or rebind. An existing bound template that was deleted, renamed or externally replaced fails closed and needs explicit reconciliation. The additive migration refuses conflicting legacy name reservations rather than deleting or rewriting history.

A missing template follows upload/readback → unattached version creation → successful import → template creation/readback. Coder receives no `template_id` on the initial version, then only the fixed name and verified `template_version_id` on template creation. Creation makes that initial version active, matching the owner's existing publish action. It does not send an additional activation PATCH or choose ACL, schedule, README metadata or variable overrides.

The response must match organization/name, current Coder creator and initial active version. The controller independently reads the template and now-attached version, checking its original file, import job, creator, initiating user, version name and artifact marker before binding the remote UUID and completing. The original create job keeps `expectedActiveVersionId=null` and immutable create mode. Later explicit publishes use update mode on the same reserved target.

An ambiguous unattached-version request holds immediately: no template/name version lookup is available before the template exists, and nullable-template version names do not provide a safe uniqueness-based retry. An ambiguous template-creation request also holds, even if the provider actually created it. Lease expiry cannot resend either effect or adopt a matching remote object. Exact owner/session/request/artifact retries return a historical receipt before fresh mode preflight; they grant no claim, execution, unhold or new effect.

## Existing-template semantics

New update requests pin the active-version ID and a SHA-256 digest of bounded canonical provisioner tags. Raw tag values remain ephemeral. Before import creation the controller rereads that exact version, rejects changed material, and sends its tags with the same captured actor credential. Version readback checks inherited nonempty nonreserved values and Coder's reserved-tag normalization: user scope replaces owner with the current verified Coder user; organization/default scope uses an empty owner. Tags from a browser, model, host proposal or another template/version are never accepted.

Bounds are 64 tags, 128 characters per key, 1,024 per value and 16 KiB canonical JSON; controls are rejected. Schema-27 jobs retain a null tag digest and their original no-tag request semantics. No migration silently adds new inputs to an existing claim.

Pinned Coder already reuses template variables inside `includeLastVariableValues` when a version belongs to an existing template. The adapter keeps `user_variable_values=[]` and never reads, stores or copies sensitive values. Missing new required values fail/hold; this slice adds no variable-entry form. Hive's baseline CLI uses `--directory -`, which skips README frontmatter and tfvars-file discovery. Existing display name/icon/description therefore remain unchanged; adding README mutation would be a new behavior.

## Persistence and progress

Migration `20261029170000_template_publication_creation` adds create/update mode and nullable tag digest, relaxes only the two required remote-ID fields needed for first creation, adds organization/catalog-name uniqueness and replaces the target immutability function with a constrained null→UUID binding. The binding requires the exact live current create claim, successful import, known version and recorded template-creation effect. Existing UUIDs, job inputs, events, leases and terminal history remain protected. SQL 27 is unchanged.

First-create progress adds fixed template-started/created labels. Its Coder link appears only at the appended `template_created` event, preserving the earlier SSE prefix across reconnects. A historical failed unattached import does not acquire an invented template link after another job later creates the reserved name.

## Validation and remaining gates

`template-publication-creation-local/` records a new local PostgreSQL-28 fixture, a populated 27→28 upgrade preserving every old column/row in all 38 tables (including 90 publication jobs), known legacy defaults and listed source hashes. The actual local workerd proof uses synthetic auth/Coder bindings, real canonical ASSETS bytes and real Worker Prisma/Serializable PostgreSQL transactions. It covers first creation, a subsequent update on the same target, unknown unattached/template effects and the earlier update uncertainty paths. Run `node deploy/cloudflare/jobs/run-local-publication.mjs --creation`; retained schema-27 evidence is separate.

The first workerd extension correctly rejected its fixture trying to edit an already-held terminal job; the fixture was corrected to stop after the second stage for an unknown unattached version. This was a test sequencing error, not permission to weaken immutable history. Its private failure is retained at `/tmp/hive-publication-workerd-UCWl3s/private-result.json`.

F07 cutover remains incomplete: an authenticated bounded detailed-log viewer and portable terminal push-notification parity still need review/implementation; only safe labels, metadata and Coder links are returned here. Unknown-effect operator reconciliation, real-provider proof, deployment/cron readiness and the documented external-publisher no-CAS limitation also remain. Flags stay off and tests make no real provider/cloud writes.

## Pinned primary sources

- [Coder v2.38.4 CLI push](https://github.com/coder/coder/blob/v2.38.4/cli/templatepush.go): stdin behavior, inherited provisioner tags and creation sequence.
- [Template creation handler](https://github.com/coder/coder/blob/v2.38.4/coderd/templates.go) and [SDK create request](https://github.com/coder/coder/blob/v2.38.4/codersdk/organizations.go): initial version attachment and automatic active version.
- [Provisioner variable reuse](https://github.com/coder/coder/blob/v2.38.4/coderd/provisionerdserver/provisionerdserver.go) and [reserved-tag normalization](https://github.com/coder/coder/blob/v2.38.4/provisionersdk/provisionertags.go): no secret copying and current-user owner enforcement.
- [Template API](https://coder.com/docs/reference/api/templates) and [pinned version handler](https://github.com/coder/coder/blob/v2.38.4/coderd/templateversions.go): scoped version/file/import identity and nullable template attachment.
