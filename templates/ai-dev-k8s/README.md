# Software Development Workspace on Kubernetes

This Coder template provides the general-purpose software profile used by Hive. It runs as a
non-root Kubernetes Deployment with a persistent Longhorn home volume and keeps implementation,
debugging, browser testing, and review work inside an interactive TUI session.

## Runtime

- Profile: `software`
- Image: digest-pinned `ghcr.io/kethalia/hive-base`
- Requests: 6 CPU and 16 GiB memory
- Limits: 12 CPU and 32 GiB memory
- Persistent home: 100 GiB at `/home/coder`
- Workspace project root: `/home/coder`

The pod has no host Docker socket and no guaranteed GPU. Container builds must use a rootless or
remote builder.

## Tool surface

The profile enables Claude Code, Codex, headed Playwright, code-server, File Browser, GitHub CLI,
Node.js package managers, Foundry, GitHub Actions `act`, tmux persistence, and software-focused
editor extensions. Agent capabilities are limited to pinned vendor-published or OpenAI-curated
skills and the official GitHub plugin.

The shared skill baseline includes `cloudflare-deploy`, `security-best-practices`,
`security-threat-model`, `vercel-react-best-practices`, `vercel-composition-patterns`, and
`web-design-guidelines`. Playwright remains an MCP server rather than a duplicated skill.

On first startup, `repositories.txt` is cloned under `~/projects`. Edit that manifest before pushing
the template when the default repository set should change.

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
and persistence across a stop/start cycle before promoting a new version.
