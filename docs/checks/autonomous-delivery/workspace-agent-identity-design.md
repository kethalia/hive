# Authenticated runtime agent identity

The live Coder deployment reports `v2.38.4+d16b1ca`. Its provisioner replaces
Terraform agent resource IDs with new runtime UUIDs before persistence. The
read-service bootstrap faithfully preserved the Terraform value, so a freshly
verified owner/app ticket was rejected on `agentId` alone. Signature, issuer,
audience, profile, current build and other static app fields matched. The failed
fresh-nonce loopback proof is preserved in `workspace-read-live-identity-mismatch.json`.
The same template assumption appears in the managed-host bootstrap.

The fix must preserve exact runtime `agentId` in signed claims. A fixed startup
helper will use the official Coder Go SDK pinned to `v2.38.4`, authenticate with
only the workspace agent credential, and read one manifest over Coder's supported
Agent RPC. Its explicit client role must avoid replacing the main agent connection.
There is no supported REST `GET /workspaceagents/me` identity endpoint, and the
agent credential cannot read the standard owner-scoped workspace API. An
unauthenticated loopback debug manifest is not an authority source.

The helper must use the configured HTTPS Coder origin, verify TLS, reject redirects,
bound total time and response size, and never log the credential or raw manifest.
It must check workspace identity, agent/workspace/owner names and the exact static
app ID, slug, owner sharing, subdomain and loopback target. A provisioner-owned
`HIVE_RUNTIME_BUILD_ID` in manifest environment metadata must equal the bootstrap
build, since the manifest has no dedicated build ID field. Only after these checks
may the installers replace the provisional agent ID with the authenticated runtime
ID. Effective config and receipt hashes must describe the resulting exact bytes;
the original bootstrap identity must remain recorded separately.

Both read and managed-host installers need this boundary. The read service and
native runtime receive no agent credential. Existing project-host outer agent
credential handling for its controlled GitHub authentication remains unchanged. There is no owner-token fallback, local-debug fallback,
unsigned host enrollment, relaxed app/agent binding, or same-build identity change
on a verified running installation. Unknown or changed identity retains the hold.

The helper is an image asset, not part of a public template annotation or embedded
host archive. Build dependencies, toolchain checksums, executable size and reproducible
recipe will be reviewed before any image change. A task-created test artifact may
be used for a bounded read-only Agent RPC proof only after parent review; no
installed package or running service is changed during investigation.

Primary source: [Coder provisioner runtime UUID assignment](https://github.com/coder/coder/blob/v2.38.4/coderd/provisionerdserver/provisionerdserver.go#L2116),
[official Agent SDK connection](https://github.com/coder/coder/blob/v2.38.4/codersdk/agentsdk/agentsdk.go#L352),
and [manifest protocol](https://github.com/coder/coder/blob/v2.38.4/agent/proto/agent.proto#L77).

The first new-image startup exposed a second, separate compatibility check:
Coder's named-app `SubdomainName` is canonical without an agent component, while
the configured app origin deliberately selects the explicit `main` agent alias.
The pinned SDK [canonical app-name contract](https://github.com/coder/coder/blob/v2.38.4/coderd/database/db2sdk/db2sdk.go#L661)
and an authenticated manifest read confirmed this for both services. The helper
now derives both representations with the official `appurl.ApplicationURL` type,
checks the configured alias against the manifest agent name, and independently
checks the canonical named-app label. Exact runtime agent UUID and all other
owner/build/static-app checks remain required. The original failure and new
source/reproducible-build proof are in `workspace-identity-live/helper-canonical-*.json`;
no installed helper was replaced and new-image runtime acceptance is pending.
