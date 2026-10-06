# Codex restricted sandbox rollout

The Kubernetes mount failure is fixed in the dedicated Infrastructure canary.
On 2026-10-06, `daniel/codex-sandbox-infra` ran under `hive-codex-v1 (enforce)`:
an authenticated App Server turn executed a command, read its allowed fixture,
and was denied access to an outside fixture. After a full Coder stop/start,
the same thread resumed and repeated that result. Read-only and scoped-write
Linux checks also passed before and after the restart.

This change opts the five Hive workspace profiles into that policy and replaces
the original diagnostic with the stricter verifier reviewed in
[k8s-cluster #368](https://github.com/kethalia/k8s-cluster/pull/368).
The global templates and existing workspace builds are not changed by this PR.
Promote templates after review; existing workspaces require an update/restart.
Do not restart the primary workspace without explicit user authorization.

## Root cause and deployed prerequisite

The container runtime's default AppArmor profile denied the mount operations
used by Codex's nested bubblewrap sandbox (`Failed to make / slave: Permission
denied`). The versioned node policy permits the required mount operations while
retaining the container boundary. Workspace containers remain non-root, drop
all capabilities and prohibit privilege escalation. Runtime defaults are unchanged.

The installed node policy is managed in
[`k8s-cluster/infrastructure/codex-sandbox`](https://github.com/kethalia/k8s-cluster/tree/main/infrastructure/codex-sandbox).
Its SHA-256 is
`3f62a08d4b694def82c75d419cb68ce2c2a1a2fb402a932421944291da30ba29`.
The reviewed installer loads it and persists `/etc/apparmor.d/hive-codex-v1`
for the enabled AppArmor boot service. All three nodes (`k3s-01`, `k3s-02`, `k3s-03`) passed the read-only and scoped-write checks. Only validated nodes receive
`hive.kethalia.com/codex-sandbox=hive-codex-v1`.

Hive requires that node label and assigns `localhost/hive-codex-v1` to `dev`.
The `seed-home` init container retains its defaults. A missing label prevents
scheduling; a missing node policy prevents startup rather than falling back.

## Acceptance evidence

The Infrastructure canary used the non-active template version
`sandbox-canary-20261006` and node `k3s-03`. After restart, pod UID was
`c013ff09-187f-4e52-bf99-82a997fe7421`, with actual image ID
`ghcr.io/kethalia/hive-base@sha256:cd6eee99fcd8e2afbcbdc116ad2630dba5c2a7e7d4bfe52e62c909bf14c4ef2f`.
The active global template remained unchanged.

Sanitized evidence in [checks/codex-sandbox/rollout](checks/codex-sandbox/rollout):

- `before-read.json` and `before-write.json`: both Linux permission modes pass.
- `after-read.json` and `after-write.json`: both pass after pod recreation.
- `start-report.json` and `resume-report.json`: same authenticated thread,
  completed commands, confirmed `hive-canary` profile, `OUTSIDE_DENIED` output.

The stricter verifier requires affirmative AppArmor, all five zero capability
masks and `NoNewPrivs: 1` before running probes. It verifies allowed reads,
scoped writes, denied outside reads/writes/creation, symlink escapes, a sibling
of the Codex executable, and network access against a live positive control.
Startup failures, unavailable tools and timeouts never count as denial evidence.

The App Server test uses synthetic data and a private temporary configuration.
Its reports contain no authentication. It validates the App Server API, not the
Studio UI or Studio's current client implementation. Studio still needs to use
these client requirements before its own acceptance check can pass:

- Readable roots include the exact native Codex ELF executable, because the
  sandbox re-enters it. Do not allow its entire installation or home directory.
- Permission profiles must have a valid `default_permissions` selection when
  configuration is reloaded for authenticated account/workspace routing.
- Use the validated bundled bubblewrap. A different helper requires revalidation.

## Run the diagnostic

Open **Codex restricted sandbox readiness** in the workspace, or run:

```sh
python3 templates/ai-dev-k8s/scripts/codex-sandbox-readiness.py
python3 templates/ai-dev-k8s/scripts/codex-sandbox-readiness.py --writable-fixture
```

The default is the native executable in Hive's persistent Linux x64 npm install.
Use `--codex /absolute/path/to/native/codex` for an isolated alternative with its
sibling `codex-resources/bwrap`. The diagnostic accepts only these validated
Linux x64 CLI/helper pairs:

| CLI | Bundled helper SHA-256 |
| --- | --- |
| `codex-cli 0.160.0` | `01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8` |
| `codex-cli 0.160.1` | `77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c` |

A supported CLI with the other version's helper still fails closed.
The diagnostic never installs or replaces tools. Other versions/platforms fail
closed pending validation. No startup hooks or AI-tool upgrade behavior change.

The diagnostic uses private synthetic fixtures and no credentials or model
calls. It needs a writable runtime directory for a temporary sibling sentinel,
removes its fixtures, and returns nonzero unless all checks pass. The terminal
app has a 240-second limit and runs on demand.

## Promotion and rollback

After this PR is reviewed and merged, publish the updated template scaffolds,
then update/restart one workspace at a time and repeat its diagnostic. Retain
homes and PVCs. Desktop and application-specific smoke checks remain separate
from the Linux boundary checks; those profiles were not restarted by this task.

To roll back, stop restricted turns, restore the preceding template version,
and update/restart the affected workspace. This restores the original
fail-closed sandbox startup error; never compensate with unrestricted mode.
Remove a node's readiness label before retiring its policy, and unload/remove
the policy only after no running container references it. Keep the reusable
Infrastructure canary and its PVC; stop it when idle.

## Missing bubblewrap startup warning

`tools-ai.sh` exposes the installed Codex npm package's bundled helper as
`~/.local/bin/bwrap` when no `bwrap` command exists. It preserves existing
commands and occupied destinations, needs no root access, and skips unsupported
platforms or missing helpers. The symlink follows the stable npm package path
across updates; it does not copy or independently upgrade bubblewrap.

On the primary software workspace, Codex 0.160.1's App Server reproduced the
missing-helper warning with `/usr/bin:/bin` and started without that warning
with the link present. Both read-only and scoped-write boundary checks passed
using PATH selection of the same bundled helper (SHA-256
`77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c`).
The on-demand diagnostic now accepts both validated versions with their exact
helper digest. Its isolated empty PATH continues to exercise bundled selection.

An already-open Codex session can retain its startup warning. Start a new Codex
session after the link is installed; a workspace restart is not needed for
that session to discover it.
