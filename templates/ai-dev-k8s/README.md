# Development and Orchestration Workspace on Kubernetes

This Coder template provides Hive's persistent primary profile. It runs as a non-root Kubernetes
Deployment with a persistent Longhorn home volume and keeps repository implementation, debugging,
CI, review, and specialist workspace coordination inside an interactive TUI session.

## Runtime

- Profile: `software`
- Image variant: digest-pinned `cli`
- Requests: 6 CPU and 16 GiB memory
- Limits: 12 CPU and 32 GiB memory
- Persistent home: 100 GiB at `/home/coder`
- Workspace project root: `/home/coder`

The pod has no host Docker socket and no guaranteed GPU. Container builds must use a rootless or
remote builder.

## Tool surface

The headless profile enables Claude Code, Codex, the Coder CLI, code-server, File Browser, GitHub CLI, Node.js
package managers, Foundry, GitHub Actions `act`, tmux persistence, and software-focused editor
extensions. It does not install or start XFCE, KasmVNC, Chrome, Playwright, Unity, Blender, or KiCad.
Browser validation belongs in `browser-testing`; game, electronics, and infrastructure work can be
handed to their matching specialist profiles when they require isolated tools or credentials.

The shared skill baseline includes `cloudflare-deploy`, `security-best-practices`,
`security-threat-model`, `vercel-react-best-practices`, `vercel-composition-patterns`, and
`web-design-guidelines`.

On first startup, `repositories.txt` is cloned under `~/projects`. This is the durable repository
home and replaces the retired standalone orchestrator profile. Edit the manifest before pushing the
template when the default repository set should change.

## Prerequisites

- Coder 2.x in the target Kubernetes cluster
- Deployment and PVC permissions in the `coder` namespace
- `ghcr-pull-kethalia` image pull secret
- GitHub external auth registered as `github`
- Longhorn storage class

## Publish

```bash
coder templates push ai-dev-k8s --directory templates/ai-dev-k8s --yes
coder create --template ai-dev-k8s software-01
```

Verify Coder SSH, the Hive terminal, agent login, code-server, File Browser, repository bootstrap,
Coder workspace discovery, and persistence across a stop/start cycle before promoting a new version.
