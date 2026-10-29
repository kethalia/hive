# Managed host template installation checkpoint

Status: implemented and validated locally; inactive preview template and test-workspace
acceptance are still required. Production manager execution remains disabled.

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
