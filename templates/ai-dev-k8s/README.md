# AI-Assisted Full-Stack Development on Kubernetes

This Coder template provisions a non-root Kubernetes workspace Deployment with
a persistent Longhorn home volume. It carries forward the AI, browser, Node.js,
Foundry, editor, game-development applications, and terminal tooling from the Docker-backed `ai-dev`
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

The template has no user-configurable creation parameters or Terraform input
variables. It uses the fixed 100 GiB home volume and `/home/coder` project root,
while Claude Code follows its own current model and system-prompt defaults.

Docker socket access is intentionally absent. Container builds must use a
rootless or remote builder in a later template iteration.

## Repository Bootstrap

After GitHub authentication is configured, the first startup reads
`repositories.txt` and clones the represented repositories under `~/projects`,
retaining the source workspace's owner/repository directory layout. The script
is idempotent: directories that already contain a Git checkout are skipped, and
failures are summarized without deleting successful clones.

The generated helper can be rerun after correcting authentication:

```bash
~/clone-repositories.sh
```

## Game Development

The base image includes Blender 4.5 LTS, Unity Hub, Mesa software-rendering
support, and VS Code extensions for C#, Unity, and shaders. Open the Coder
Desktop to launch either application. Unity authentication, licenses, Editors,
and projects are intentionally stored in the persistent home volume; install
the current Unity 6.3 LTS Editor from Hub on first use.

## Electronics Design

KiCad 9, its standard symbols, footprints, templates, 3D models, and
`kicad-cli` are image-baked. Launch the GUI from Coder Desktop.

The template does not install domain-specific agent skills or third-party MCP
servers for Unity, Blender, or KiCad. Use each vendor's official documentation
and tooling. Unity Editor 6 users may enable Unity's official MCP server through
the Unity AI Assistant package.

## Curated Agent Capabilities

The workspace installs a deliberately small, revision-pinned skill baseline
from public official sources. The Vercel `skills` installer keeps one canonical
copy and exposes it to both Claude Code and Codex:

- OpenAI-curated `cloudflare-deploy`, `security-best-practices`, and
  `security-threat-model`
- Vercel-authored `vercel-react-best-practices`,
  `vercel-composition-patterns`, and `web-design-guidelines`

Codex also receives OpenAI's official GitHub plugin from a pinned checkout of
`openai/plugins`. Plugin connector authentication may require opening `/plugins`
after signing in to Codex. Playwright remains an MCP server rather than a
duplicated skill, and no locally authored domain-expertise skills are installed.

Obsidian remains installed as a standalone notes application, but Hive no
longer clones or syncs a vault, injects vault instructions or skills, registers
an Obsidian MCP server, or starts Obsidian automatically.

## Publish

From the Hive repository root, authenticate the Coder CLI against the new
deployment and push the template:

```bash
coder login https://coder.kethalia.com
coder templates push ai-dev-k8s \
  --directory templates/ai-dev-k8s \
  --message "Initial Kubernetes workspace template" \
  --yes
```

Then create a fresh workspace:

```bash
coder create --template ai-dev-k8s ai-dev-k8s-01
```

Verify `coder ssh`, `~/projects`, the web terminal, code-server, Codex, Claude
Code, Unity Hub, Blender, Node.js, Foundry, and persistence after a stop/start
cycle before treating this template as the default. The Kubernetes template
does not expose a GPU, so validate production rendering and frame-time behavior
on a GPU-enabled workspace or workstation.
