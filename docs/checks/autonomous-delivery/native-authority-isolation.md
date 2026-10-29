# Native execution authority: unresolved isolation gate

2026-10-29. Independent review found that host journals/signing material and native Codex run
under the same Unix account. Mode 0600 protects against other users; it does not prevent a local
command launched by that account from reading or changing those files. Signed ingestion alone
therefore cannot establish independent observation authority. Managed delivery remains disabled.

The installed Codex 0.165.0 protocol exposes `ThreadStartParams.permissions` as a named profile,
mutually exclusive with `sandbox`. Official documentation describes exact-path deny rules and
managed profile allowlists; it also warns that legacy sandbox configuration can override ordinary
permission-profile defaults. Reference: https://learn.chatgpt.com/docs/permissions.

Candidate implementation to validate, not an accepted security claim:

- Give the managed native runtime a dedicated config/home, containing only its required Codex
  account state and approved integrations. Do not inherit owner CLI tokens, production credentials,
  arbitrary MCP servers or user configuration that can silently remove its sandbox.
- Pin the permission profile and approval policy through a boundary the model cannot alter.
  Deny access to controller/supervisor journals, signing keys, native WebSocket tokens, installed
  host packages/config and credential-bearing process metadata. Keep the project checkout writable.
- Check indirect access through symlinks, alternate paths, inherited file descriptors, parent
  process `/proc` paths and child tools. Confirm the profile applies after resume and subagent spawn.
- If the pinned Codex interface cannot enforce this, isolate the native process/commands with
  a separately controlled OS identity or namespace boundary. A private directory is insufficient.
- Exercise these controls with the actual native runtime in the test workspace: successful ordinary
  project edits plus failed protected-file reads/writes, attempted policy changes and signer/token
  access. Preserve the denial evidence and verify that failed setup does not fall back to full access.

Actual native events can establish observed model/turn/command facts only after that boundary
passes. A successful command exit never substitutes for trusted CI, review or deployed verification.
Unknown active child threads/background operations retain the writer hold and require reconciliation;
interrupting the root thread is not proof that every child or process stopped.
