# Specialist Coder credential boundary

Validated in disposable Infrastructure workspace `daniel/hive-coder-credential-check`.
The root template keeps `coder-login` only for `software`; its primary pod command
remains the Coder agent's original init script. Each specialist pod uses a wrapper
that clears inherited owner auth and runs local credential migration before the
agent, every startup script, and every terminal.

`verification.json` records source hashes and workspace cleanup. `live-report.json`
contains sanitized authentication outcomes. No token values or key IDs are stored
in these artifacts. `terraform-report.json` covers fmt/validate and mock plans for
all five profiles, with both providers mocked and no live plan/apply. The native
Terraform fixture is `credential-boundary.tftest.hcl`; run it only in Infrastructure,
with the repository lockfile and each profile's `profile.json`.

The live fixture used the reviewed entrypoint with an agent marker in place of the
agent init script. Before cleanup the disposable workspace had `coder:all` owner
authentication. After cleanup, `coder list` failed and `coder external-auth
access-token github` succeeded using the unchanged agent credential. The primary
workspace's stored credential did not change and its Coder management access
continued to work. This is a bounded runtime check, not a production template rollout.

Regression checks cover all four specialists, primary preservation, repeat startup,
XDG/custom config directories, other deployment logins, session symlinks, and unsafe
or ambiguous paths that prevent agent startup. Run them with
`node --test scripts/verify-coder-credential-boundary.test.mjs`.

Rollout requires updating templates and restarting specialists, including workspaces
with persistent homes. The migration covers the session file used by the currently
pinned Coder CLI. Config roots containing credentials outside the private workspace
home, missing/invalid deployment URLs, symlinked sessions, or files owned by another user need operator
cleanup before startup. Explicit credentials for other Coder deployments are retained.
Removing local credentials does not revoke copied tokens on the server. Primary
software processes retain owner-level Coder access as required for orchestration.
