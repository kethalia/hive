# Managed host template installation checkpoint

Status: packaging and Terraform validation pass. The first enabled test workspace exposed
a Coder startup argument-size failure; the mounted bootstrap fix awaits deployed acceptance.
Production manager execution remains disabled.

The software template has an opt-in `enable_hive_projects` parameter and a Hive account
identifier. The deployment supplies the HTTPS controller origin, public Ed25519 issuer
key and key ID, application wildcard domain, and model/effort defaults. The private
issuer key is never placed in a workspace or Terraform input. Coder workspace, owner,
agent, template and app identities come from provider resources. Coder's provisioner
supplies the build UUID through `CODER_WORKSPACE_BUILD_ID`; the pinned official HashiCorp
external provider reads only that validated value. HTTP tickets cannot choose these
identities. Hive independently verifies the current Coder resource binding and ownership.

The private, owner-only `codex-session` application points to loopback port 13341.
The startup script installs a deterministic template-pinned host archive under the
private `~/.local/share/hive/codex-host/<archive-sha256>` path. It verifies each file,
the manifest, the locked WebSocket distribution, and the separately pinned official
native runtime. No package manager resolves runtime dependencies during installation.
The generated archive is checked against canonical source by `pnpm templates:check`;
`pnpm templates:sync` regenerates it and all profile copies. Shared dependency stores
and differing checkout paths produce identical archive bytes.

Host configuration and process receipts are private. Startup verifies PID, kernel start
time, boot identity, executable and actual loopback listener ownership before accepting
readiness. A live matching host is reused. A live host with changed configuration or
package is retained and the update fails: a workspace rebuild, after work is preserved,
is required for replacement. Installation never deletes project directories, task journals,
session history or old packages. Owner CLI credentials are excluded from the host environment;
only the agent-scoped GitHub helper receives the agent credential. Manager activation is
hard-disabled in this installer until the independent native authority isolation gate passes.

Validation used a staged source export to exclude concurrent manager implementation:

- All 83 template checks passed, including seven installer/build-identity cases and an
  archive reproducibility check; the three host package checks also passed.
- Infrastructure workspace `58aa07af-3717-455e-927f-a0e839374b33` ran Terraform format and
  validation successfully using Terraform 1.15.8, Coder provider 2.18.0, HashiCorp external
  2.4.2 and Kubernetes 2.38.0. Creation provenance is in `infrastructure/workspace-creation.json`.
- Tests exposed and fixed newline acceptance in the build UUID helper and a transient
  `/proc` descriptor race in listener ownership detection. Tampered packages, archive
  traversal/links, changed live configuration and specialist activation are rejected.

These checks establish packaging behavior, not account-backed inference, trusted manager
evidence, browser acceptance, or production readiness. See `native-authority-isolation.md`
for the unresolved same-UID authority boundary.

## Mounted bootstrap correction

The first enabled test build (`cbb961eb-5074-4dd1-b9ea-877b356b8528`) provisioned
successfully but its managed-host script exited 255 before producing any output or
installing files. Coder 2.38.4's [script runner](https://github.com/coder/coder/blob/v2.38.4/agent/agentscripts/agentscripts.go)
passes the script to [CreateCommand](https://github.com/coder/coder/blob/v2.38.4/agent/agentssh/agentssh.go),
which executes the complete script through shell `-c`. A local reproduction with the
same template package produced a 532,915-byte argument and Linux `E2BIG`; putting a
here-document inside that argument does not avoid the limit.

The corrected template places a compressed public archive, public controller configuration
and installer into bounded pod annotations, projected into a read-only Downward API
volume. The small startup command reads the request from a file. Changed bootstrap
annotations change the pod template, triggering its existing Recreate strategy. The
installer still rejects changed live configuration instead of replacing a running host.
The Terraform precondition bounds annotation key/value UTF-8 bytes below 240,000 bytes,
leaving headroom below Kubernetes' 256-KiB annotation limit. Build tooling additionally
limits the compressed archive to 160,000 bytes; the installer bounds decompression to
two MiB before validating the original tar digest and file manifest. No private issuer
key or account credential belongs in pod metadata.

An intermediate immutable ConfigMap implementation passed Terraform validation but
failed test build `08dfc377-6f0f-4914-8750-808e2b019f50`: the Coder service account
cannot create ConfigMaps. No RBAC changes were made. The Downward API implementation
uses the already-authorized Deployment and does not introduce another resource type.

The regression test executes the real small shell script with a package over the Linux
argument limit and verifies its entire SHA-256 through stdin. All 86 template checks pass from an isolated staged export, including the new bounded
decompression test in the installer suite. Terraform formatting and validation pass in the new
bounded infrastructure workspace recorded in `infrastructure-bootstrap/workspace-creation.json`.
The previously used infrastructure workspace was already stopped and deleted; its
creation record was not reused.
