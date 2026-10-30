# New image runtime acceptance probe

The harness is prepared and has not been run against a workspace. Root owns image
publication, the inactive template version, the exact new build and a dedicated
existing `web` tmux session. It never performs those operations itself.

The private plan lives under `/tmp/hive-epic-coder-auth/`, owned by the current UID,
mode0600, no symlink or hardlink. Its exact keys are:

```json
{
  "schemaVersion": 1,
  "workspaceId": "<verified dedicated workspace UUID>",
  "ownerId": "<dedicated codex account UUID>",
  "templateId": "<reviewed template UUID>",
  "templateVersionId": "<reviewed inactive version UUID>",
  "buildId": "<new running build UUID>",
  "imageDigest": "sha256:<published immutable image digest>",
  "imageSourceSha": "<full reviewed image source commit>",
  "helperSha256": "<helper hash from the image job proof>",
  "readArchiveSha256": "<expanded read package archive hash>",
  "readManifestSha256": "<read manifest hash>",
  "hostArchiveSha256": "<expanded host archive hash>",
  "hostManifestSha256": "<host package manifest hash>",
  "hiveOrigin": "<configured HTTPS issuer origin>",
  "githubAccountId": "<independently verified connected GitHub account ID>",
  "repositoryId": "<independently verified kethalia/hive repository ID>",
  "expectedRefSha": "<fresh exact remote codex/delivery-system-design commit>",
  "projectsRoot": "/home/coder",
  "sessionName": "hive-identity-proof",
  "expectedCwd": "/home/coder"
}
```

The session must already exist in fixed `tmux -L web`; the harness creates no
session and never opens a private managed-project socket. Missing CWD coverage
fails explicitly. Other configured-root/profile coverage remains outside this
single software-workspace acceptance.

After root separately authorizes the exact image/version/build:

```sh
node --no-experimental-strip-types --import tsx \
  scripts/probe-workspace-runtime-identity.mjs \
  --run /tmp/hive-epic-coder-auth/workspace-runtime-identity-plan.json \
  --evidence docs/checks/autonomous-delivery/workspace-runtime-identity-live.json
```

The output file must not exist: success and first failure cannot overwrite prior
proof. Standard output contains only aggregate status, stage, request count and
evidence location. Exceptions, credentials, app-connect query values, provider
responses, repository catalogs, paths and configurations are not logged.

The probe uses only the private test-user session and scoped issuer key already
prepared by root. Before sending a ticket it independently checks current owner,
workspace/build/template/version and exact connected agent/app through Coder.
The product `WorkspaceReadClient` verifies signed identity, lifetime and response
schemas for sessions, directory and paths. It checks existing CWD and explicit
file/directory/missing/outside-root results. The host app receives only signed
`/projects/discover`, `/projects/resolve` and `/projects/resolve-ref` requests. The
repository/account and full epic branch SHA must match the reviewed plan.

A single read-only SSH session, using an empty private CLI config directory and
only the test user's explicit session, checks the root-owned helper SHA, package
file hashes, normalized effective configs, original bootstrap config digests,
read receipt HMAC and exact live Node PID/start/boot/executable/argv. It observes
credential *names* only: the read service must contain no agent or owner
credential. The project-host outer's existing agent credential remains permitted;
an owner session credential does not. No helper RPC or inference is invoked by
this inspection.

Limits are80 directly counted HTTPS fetches,90s total network stage and one SSH
client with15s deadline. SSH protocol traffic and the bounded GitHub helper's own
requests are separate from the direct fetch counter. Direct Coder API requests
are GET; app POST endpoints are fixed reads. Scoped app authentication and replay
ledgers may advance as normal authorization bookkeeping. No GitHub write, tmux
creation or project enrollment occurs. An abort is not a quiescence
claim. Whole image identity comes from the parent-reviewed deployment record;
component hashes are independently observed inside the runtime.

Local validation:

```sh
node --test scripts/probe-workspace-runtime-identity.test.mjs
python3 -B -m unittest scripts.agents.test_workspace_runtime_identity_probe
```
