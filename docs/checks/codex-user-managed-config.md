# Codex registry module checks

All five workspace templates use the released `coder-labs/codex` 5.5.0 module
with installation and configuration management disabled. The regression in
`scripts/verify-workspace-profile-templates.test.mjs` runs in `pnpm test:templates`
and rejects API-key, gateway, or configuration inputs, while retaining Hive's
updater and native launcher. `pnpm templates:check` checks scaffold synchronization.

The Terraform fixture is
[`codex-user-managed-config.tftest.hcl`](../../scripts/fixtures/codex-user-managed-config.tftest.hcl).
To run it, use an Infrastructure workspace and a temporary copy of each template.
Copy the fixture into that copy's `tests/` directory, then run `terraform init
-backend=false`, `terraform fmt -check`, `terraform validate`, and `terraform test`.
Both providers are mocked; these tests only plan and never apply resources.

Validation on 2026-10-31 used Terraform 1.15.8 in the reused Infrastructure helper
`hive-data-rehearsal`. Every profile passed formatting, validation, and both mock
plans. Mock plan inspection confirmed one Codex startup script when running, no
Codex resources when stopped, and no module-provided authentication environment
variables. The official registry supplied module 5.5.0; provider versions and
lockfiles remained unchanged.

The actual rendered installers also passed 40 isolated runs: two runs each with
existing or absent configuration, at both default and custom `CODEX_HOME` paths,
for every profile. Existing config/auth contents, permissions, and modification
times were preserved, and absent config directories were not created. A stub CLI
accepted only `--version`, so unexpected login attempts would fail. Evidence was
preserved in the primary workspace before stopping the reused helper. No proposed
template was uploaded or applied, and no running workspace was updated.
