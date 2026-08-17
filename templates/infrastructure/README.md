# Infrastructure Workspace on Kubernetes

This Coder template isolates platform and desired-state repository work from application development
in a headless CLI image, with a smaller resource envelope, infrastructure editor extensions, a
focused repository manifest, and conservative live-environment guidance.

## Runtime

- Profile: `infrastructure`
- Requests: 4 CPU and 8 GiB memory
- Limits: 8 CPU and 16 GiB memory
- Persistent home: 75 GiB
- No cluster credentials or production authority granted by the template
- Image variant: `infrastructure` (no desktop, Chrome, Playwright, or domain GUI applications)

GitHub CLI, Docker client, GitHub Actions `act`, Claude Code, Codex, code-server, File Browser, and
infrastructure editor extensions are available. Terraform 1.15.8, kubectl 1.34.5, Helm 3.16.4, and
Argo CD 3.3.4 are image-baked and checksum-verified; repository-pinned wrappers still take
precedence when present.

## Publish

```bash
coder templates push infrastructure --directory templates/infrastructure --yes
coder create --template infrastructure infrastructure-01
```

Verify repository bootstrap, editor extensions, agent login, Coder terminal persistence, and
read-only validation before authorizing access to any live environment.
