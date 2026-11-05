# Delivery pilot preparation

`--delivery-pilot-candidate` is an explicit update-only option, in addition to
`--inherit-preview-secrets --native-gateway-candidate --workspace-projects-candidate`.
It enables the software workspace's project tasks, terminal, paste, voice, agent
bridge and guarded manager. The existing read-only workspace candidate remains unchanged.
The pilot does not enable epics, acceptance, database migrations or release automation.

Preparation verifies the existing issuer public key and scope against fresh provider
evidence. It does not create, copy or rotate the issuer. Explicit `shared-host` mode
lets voice and agent tools use the existing host issuer secret only after exact origin,
key ID, public key and single software-template checks. Dedicated keys remain the default
outside this candidate. Cloudflare's rename inheritance cannot duplicate the host secret.

`HIVE_PREVIEW_DELIVERY_CATALOG_FILE` names an operator-owned mode-600 JSON file in a
mode-700 private directory with this shape:

```json
{
  "schemaVersion": 1,
  "model": "operator-approved-model",
  "effort": "high",
  "guardian": {
    "packageManifestSha256": "<64 lowercase hex>",
    "guardianElfSha256": "<64 lowercase hex>",
    "nodeSha256": "<64 lowercase hex>",
    "protocol": "guardian-v1",
    "policyDigest": "<64 lowercase hex>",
    "metadataPolicyDigest": "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b"
  }
}
```

The operator obtains guardian pins from the reviewed installed image, not a task or
model response. Workspace-read, voice and agent pins are loaded from this commit's
software template. Reconciliation uses a new dedicated 64-hex shared secret in the
private app secrets file. Keep that file private for matching jobs preparation.

After preparation, `node deploy/cloudflare/app/prepare-delivery-pilot-jobs.mjs
<private-prepared-deployment.json>` can produce a Wrangler dry-run bundle and private
jobs files. Its config has no public URL or enabled cron. A five-minute schedule is
recorded as a proposal only. The command cannot upload or activate the Worker. A reviewed
jobs deployment and scheduling workflow, provider readback and real manager lifecycle
proof are still required; do not treat this bundle as an installed scheduler.

The terminal pilot uses the Worker-only `HIVE_TERMINAL_WS_URL=/` runtime setting;
other values fail closed and Node deployments retain their existing public-variable
behavior. Run the actual assembled Worker check with
`node deploy/cloudflare/auth/run-local-integration.mjs --app --terminal-pilot` after
building the exact committed source. This does not establish real Coder terminal access.
