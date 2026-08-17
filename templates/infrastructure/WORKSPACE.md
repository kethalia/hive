# Infrastructure workspace

Use this workspace for Kubernetes, Terraform, Helm, CI runners, deployment configuration, and
platform repositories.

## Start here

- Confirm the intended repository, environment, account, cluster, namespace, and state backend.
- Begin with status, validation, linting, plans, and diffs.
- Use repository-pinned CLIs or wrappers when available; otherwise use the image-baked platform
  clients.
- Ask before applying changes or performing any destructive external operation.

## Included tools

- GitHub CLI, Docker client, GitHub Actions `act`, and standard build tools
- Terraform 1.15.8, kubectl 1.34.5, Helm 3.16.4, and Argo CD 3.3.4
- Terraform, Kubernetes, YAML, Docker, and GitHub Actions editor support
- Claude Code, Codex, code-server, File Browser, and tmux

Browser automation belongs in the Browser Testing workspace. Cluster credentials and production
authority are intentionally not provisioned by the template.
