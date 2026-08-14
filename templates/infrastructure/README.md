# Infrastructure Workspace on Kubernetes

This Coder template isolates platform and desired-state repository work from application development.
It reuses the cached Hive base image while providing a smaller resource envelope, infrastructure
editor extensions, a focused repository manifest, and conservative live-environment guidance.

## Runtime

- Profile: `infrastructure`
- Requests: 4 CPU and 8 GiB memory
- Limits: 8 CPU and 16 GiB memory
- Persistent home: 75 GiB
- No cluster credentials or production authority granted by the template

GitHub CLI, Docker client, GitHub Actions `act`, Claude Code, Codex, code-server, File Browser,
Playwright, and infrastructure editor extensions are available. Repositories should continue to pin
their own Terraform, Kubernetes, Helm, and policy toolchains.

## Publish

```bash
coder templates push infrastructure --directory templates/infrastructure --yes
coder create --template infrastructure infrastructure-01
```

Verify repository bootstrap, editor extensions, agent login, Coder terminal persistence, and
read-only validation before authorizing access to any live environment.
