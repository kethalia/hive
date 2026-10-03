# Codex restricted sandbox readiness

Status: **blocked; not an isolation proof or a completed fix**. Studio PR #9's
[read-isolation review](https://github.com/kethalia/codex-creative-studio/pull/9#discussion_r4172873059)
must remain open. Hive now has an on-demand diagnostic and opt-in plumbing for a
node-installed AppArmor policy. No profile opts in yet. A tested node policy and
successful restricted App Server start/turn/resume are still required.

## Observed failure

On 2026-10-03, the dedicated `daniel/codex-sandbox-infra` canary reproduced the
failure with Codex **0.160.0**, before and after stop/start. Synthetic reads,
writes, symlink reads and loopback connections work in unsandboxed positive
controls. Every restricted command fails before its probe starts:

```text
bwrap: Failed to make / slave: Permission denied
```

The controls operate only on new generated files and a temporary loopback
listener; they do not read real credentials or other repositories.

Sanitized evidence: [before restart](checks/codex-sandbox/before-restart.json),
[after restart](checks/codex-sandbox/after-restart.json),
[original Studio probe](checks/codex-sandbox/studio-isolation.json), and
[original Studio App Server smoke](checks/codex-sandbox/studio-smoke.json).
The Studio source was exported from `676c606` into a separate canary directory,
installed with its frozen lockfile and built with `tsc -b`. Its smoke reports
both missing account authentication and the mount failure before thread
creation. No bounded turn or resume has succeeded.

Local validation: `templates:check`, all 35 template tests (including seven
Python evidence regressions), and Terraform 1.15.8 `validate` / `fmt -check`
passed. Terraform ran in Infrastructure with the checked-in provider lockfile.
No Dockerfile or image content changed; image boundary assertions ran as part
of the template suite. Full required PR CI is tracked on the draft PR.

| Effective observation | Result |
| --- | --- |
| Workspace/image profile | `infrastructure` / `infrastructure` |
| Kernel | `6.8.0-134-generic` |
| AppArmor | `cri-containerd.apparmor.d (enforce)` |
| Capability sets, including bounding set | all zero |
| `NoNewPrivs` | `1` |
| Seccomp mode/filter count | `0` / `0` |
| `kernel.unprivileged_userns_clone` | `1` |
| `kernel.apparmor_restrict_unprivileged_userns` | `1` |
| `user.max_user_namespaces` | `254107` |
| User namespace creation | succeeds |
| Mount namespace creation, propagation unchanged | succeeds |
| Mount namespace creation with propagation change | fails, permission denied |
| System `bwrap` on PATH | absent |
| Bundled bubblewrap version output | `bubblewrap built for Codex` |
| Bundled bubblewrap SHA-256 | `01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8` |
| Canary Codex authentication | not logged in |
| Cluster credentials | no kubeconfig/current context in Infrastructure |

The leading cause is AppArmor mount mediation: containerd's
[default policy](https://github.com/containerd/containerd/blob/main/contrib/apparmor/template.go)
explicitly denies mounts, and the failing operation is a mount propagation
change. Namespace creation itself is not blocked. These observations do **not**
justify adding capabilities or enabling privilege escalation. Node audit logs
and the installed profile are still needed to confirm the exact denial and
identify subsequent restrictions. The container runtime version, node identity,
admission mutations and effective node profile text have not been verified.

[Codex's pinned implementation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/linux-sandbox/src/bwrap.rs)
constructs a tmpfs root for restricted reads, layers readable roots, isolates
user/PID/IPC/network namespaces, mounts a minimal device tree and procfs, and
drops capabilities. Codex also applies its command-network seccomp filter. The
[pinned sandbox README](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/linux-sandbox/README.md)
documents system bubblewrap selection and bundled fallback. The actual exec
argument trace remains to be collected in the canary; source inspection is not
an execution trace.

## Repository versus deployment

Both active template archives were pulled with `coder templates pull`:

- `ai-dev-k8s`: `uptight_pearson31`.
- `infrastructure`: `maintenance-cpu-20261003`.

Their pod/container security blocks match Hive `bbe2c9e`: UID/GID 1000,
`run_as_non_root`, no service-account token mount, all capabilities dropped,
`allow_privilege_escalation=false`, no explicit AppArmor or seccomp selection.
The archives omit the newer weekly cache script. Infrastructure's deployed
profile requests one CPU, whereas repository main requests four; that unrelated
capacity repair is preserved. The canary was created from the active template,
not from a newly published Hive scaffold.

The deployed Infrastructure template declares image
`ghcr.io/kethalia/hive-base@sha256:cd6eee99fcd8e2afbcbdc116ad2630dba5c2a7e7d4bfe52e62c909bf14c4ef2f`.
This is desired configuration, not a verified Kubernetes `imageID`. No image
change is proposed. Python and util-linux are present in the canary; a separate
system bubblewrap install would not remove an AppArmor mount denial.

## Reproduce safely

In Infrastructure, run:

```sh
python3 templates/ai-dev-k8s/scripts/codex-sandbox-readiness.py
# Or select an already-installed, isolated exact CLI explicitly:
python3 templates/ai-dev-k8s/scripts/codex-sandbox-readiness.py --codex /path/to/codex
```

After publishing the scaffold, open the **Codex restricted sandbox readiness**
terminal app to run the diagnostic on demand. It does not run at startup or race
the separate AI-tools installer. It returns nonzero unless every condition passes
and is limited to 240 seconds. This uses `coder_app.command`: a `coder_script`
without a startup, shutdown, or cron trigger fails during workspace provisioning.

The check requires exactly `codex-cli 0.160.0`; it never installs, upgrades,
downgrades or changes configuration for any tool. `tools-ai.sh` retains its
existing persistent-install behavior. Use a separate npm prefix if a pinned
validation binary is needed; do not replace a user's working global install.

The diagnostic uses a temporary private home and clean environment, without
loading user Codex config, plugins or authentication. It removes only its own
generated synthetic directory. A structured probe result and successful
unsandboxed control are required for every operation. Nonzero launcher exits,
timeouts, signals, missing executables, malformed output, refused network
connections and unavailable routes never count as successful denial evidence.
Network success is tested against a live ephemeral loopback listener; restricted
access must fail with `EPERM` or `EACCES`, not a timeout or refused connection.

## Required cluster work and scope

Owner: **`kethalia/k8s-cluster`**, node security/bootstrap policy. The repository
currently has no Hive sandbox AppArmor policy or node readiness label. A cluster
operator must first provide an approved kubeconfig in the Infrastructure
workspace (normally `~/.kube/config`, mode 0600) and approved node audit access.
Do not paste credentials into chat, commit them, or extract provisioner tokens.
The primary workspace has only an empty kubeconfig cache, no usable config;
Infrastructure reports `current-context is not set`.

With that access, inspect only workload/security metadata:

1. Identify the canary pod using `com.coder.workspace.name=codex-sandbox-infra`
   in namespace `coder`. Record node, pod UID, container image IDs and security
   contexts; do not dump pod environment variables or Secrets.
2. Read the node's runtime/kernel versions, kubelet seccomp defaults, loaded
   AppArmor profile and timestamp-correlated audit mount denial. Compare them
   with repository desired state and admission policy.
3. Prepare a versioned node-local profile `hive-codex-v1` in the cluster repo.
   Keep containerd's proc/sys/kernel/device protections; replace the mount deny
   only with the operations necessary for nested bubblewrap (mount propagation,
   bind/read-only remounts, tmpfs, procfs, devpts, pivot-root and unmount, as
   confirmed by the pinned helper trace). Permit user namespaces within this
   profile. Do not grant host/container `SYS_ADMIN`, privileged mode, unconfined
   AppArmor, or globally disable AppArmor/user-namespace restrictions.
4. Validate and load the profile on the selected canary node. Only after loading
   it, label that node `hive.kethalia.com/codex-sandbox=hive-codex-v1`.
   The exact policy rules remain an unimplemented, unvalidated dependency;
   this document is not an installable policy or authorization to relax nodes.
5. If runtime seccomp becomes a separate blocker, document the exact denied
   syscalls and prepare a versioned local seccomp policy retaining the remaining
   runtime restrictions. Do not select `Unconfined` as a workaround.

Hive's opt-in `profile.json` field is:

```json
"codex_sandbox_apparmor_profile": "hive-codex-v1"
```

This selects `localhost/hive-codex-v1` for **only the `dev` container**, and a
matching required node selector. `seed-home` retains runtime defaults. The
provider locked at Kubernetes 2.38.0 lacks the typed `appArmorProfile` field,
so the scaffold uses its per-container compatibility annotation. Its behavior
must be verified against the deployed Kubernetes version before rollout.
Missing profiles/labels must prevent scheduling/startup, not cause fallback.
All five capability boundaries, non-root IDs, capability drops and
`NoNewPrivs` remain intact. Keep the field absent until its external dependency
is ready; there is no claim that absence fixes Codex.

## Canary acceptance and rollout

Run the check before and after a stop/start of the dedicated canary. Require
inside-root read success, sibling and symlink read denial, failed write with
unchanged contents, and command-network denial. Then run Studio's artifacts
from `codex/phase-2-codex-bridge`, evidence commit `676c606`, with CLI 0.160.0:

```sh
node scripts/phase-2-isolation-proof.mjs
pnpm exec tsx scripts/phase-2-smoke.ts
```

The original isolation probe is supplemental: its individual denial predicate
accepts generic nonzero exits. The Hive diagnostic is stricter. The original
Studio smoke does not test resume and does not set a failing exit code for all
failed reports. Inspect its JSON, and add/run a bounded App Server resume test
that verifies the returned restricted profile and denied commands after resume.
Authentication is required for a real model turn; do not copy user credentials
into committed evidence. Preserve the ignored raw journals.

After all acceptance checks pass, publish a canary-only template version first;
do not activate it for all workspaces. Record the actual node policy hash,
pod image IDs, Codex/bubblewrap versions, template version, all eight acceptance
outcomes and restart evidence. Only then opt the profile catalog in, run
`pnpm templates:sync`, and promote in a separate reviewed rollout. Updating a
template does not automatically replace an existing workspace build. Never
restart the primary workspace without the user's explicit authorization.

Rollback: stop new restricted Studio turns, remove the opt-in field from the
affected template version, and update/restart only the canary. This restores
the original fail-closed sandbox failure; it must not switch Studio to legacy
host-wide `read-only`. Remove the readiness label, then unload the custom host
policy only after no workloads reference it. Preserve homes, PVCs, repositories,
credentials, private port sharing and Studio journals. Retain the dedicated
canary workspace/PVC unless its deletion is explicitly authorized.
