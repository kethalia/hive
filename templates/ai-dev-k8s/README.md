# AI-Assisted Full-Stack Development on Kubernetes

This Coder template provisions a non-root Kubernetes workspace Deployment with
a persistent Longhorn home volume. It carries forward the AI, browser, Node.js,
Foundry, editor, vault, and terminal tooling from the Docker-backed `ai-dev`
template without mounting a host Docker socket.

## Prerequisites

- Coder 2.x running inside the target Kubernetes cluster.
- The Coder service account may manage Deployments and PVCs in `coder`.
- The `ghcr-pull-kethalia` image pull secret exists in `coder`.
- Coder's default GitHub external-auth provider is enabled as `github`.
- Longhorn is available as the `longhorn` storage class.

## Architecture

Each workspace creates a Kubernetes Deployment and a persistent volume claim.
The pod is ephemeral; `/home/coder` persists across stops, starts, and pod
replacement. Workspaces prefer `k3s-03` but may schedule elsewhere. The pinned
`hive-base` image runs as UID/GID 1000 with all Linux capabilities dropped.

The default home volume is 100 GiB. The workspace requests 2 CPU and 4 GiB of
memory, with limits of 6 CPU and 12 GiB.

Docker socket access is intentionally absent. Container builds must use a
rootless or remote builder in a later template iteration.

## Repository Bootstrap

After GitHub authentication is configured, the first startup clones the
repositories represented in the source workspace under `~/projects`, retaining
its owner/repository directory layout. The script is idempotent: directories
that already contain a Git checkout are skipped, and failures are summarized
without deleting successful clones.

The generated helper can be rerun after correcting authentication:

```bash
~/clone-repositories.sh
```

The second-brain repository is also cloned to `~/vault` by default so the vault
context and agent skills are available independently of its checkout under
`~/projects/kethalia/second-brain`.

## Publish

From the Hive repository root, authenticate the Coder CLI against the new
deployment and push the template:

```bash
coder login https://coder-new.local.kethalia.com
coder templates push ai-dev-k8s \
  --directory templates/ai-dev-k8s \
  --message "Initial Kubernetes workspace template" \
  --yes
```

Then create a fresh workspace:

```bash
coder create --template ai-dev-k8s ai-dev-k8s-01
```

Verify `coder ssh`, `~/projects`, `~/vault`, the web terminal, code-server,
Codex, Claude Code, OpenGSD, Node.js, Foundry, and persistence after a stop/start
cycle before treating this template as the default.
