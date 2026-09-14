# COPY Development Workspace on Kubernetes

A dedicated Hive/Coder template for [lunarresearcher/copy](https://github.com/lunarresearcher/copy).
The CLI, paper engine, and optional web wrapper use the persistent checkout at
`/home/coder/projects/lunarresearcher/copy`. Upstream was inspected and its tests passed at
`41689d331ee80f74991a1dd3d0537983ac156819` (COPY 2.1.0).

## Runtime

- Profile: `copy`; digest-pinned Hive `cli` image
- Node.js 24 (upstream requires 20+), npm, Foundry, GitHub CLI, Codex, Claude Code, and tmux
- Requests: 2 CPU and 4 GiB RAM; limits: 4 CPU and 8 GiB RAM
- Persistent Longhorn home: 25 GiB
- VS Code opens the COPY checkout; File Browser exposes the persistent home
- Owner-only **COPY Web (run copy web)** app proxies port 8787 after manual launch

The template uses Hive's standard non-root Kubernetes scaffold. It needs the `coder` namespace,
Longhorn, the `ghcr-pull-kethalia` image pull secret, and Coder's `github` external authentication.
It has no browser or desktop runtime. Visual validation belongs in `browser-testing`.

## Bootstrap

`repositories.txt` clones only COPY's default branch on first start. An existing checkout is never
pulled, reset, or replaced. `project/setup.sh` runs after repository cloning within the CI tooling
script, avoiding a race between Coder startup scripts.

Setup checks Node, creates `.env` with mode 0600 only if absent, and installs dependencies with
lifecycle scripts disabled. It uses `npm ci` when a lockfile exists and otherwise `npm install
--package-lock=false`; dependency manifests and Node/npm versions determine when installation is
needed again. Existing configuration and data files are preserved. A `copy` wrapper changes to the
repository so relative config and data paths work from any shell.

No COPY application starts automatically. Run `copy terminal --demo`, `copy terminal`, `copy paper`,
or `copy web` interactively. Provider credentials belong in the workspace's `.env`; no credentials
are template parameters. Native executor configuration starts blank, matching upstream queue mode.

The optional web app has no Coder healthcheck because it normally remains stopped. Once running,
its HTTP health endpoint is `http://localhost:8787/api/health`. A successful HTTP response does not
mean the external providers are connected; inspect `copy doctor --probe` separately.

## Publish and validate

From `ai-dev-k8s`, inspect `coder templates list` and `coder list` before creating a workspace.

```bash
pnpm templates:check
pnpm test:templates
coder templates push copy-dev --directory templates/copy-dev --yes
coder create --template copy-dev copy-dev-01
```

In Hive, open `copy-dev-01`, select the COPY repository, and run `npm test` and `copy terminal --demo`.
Verify VS Code, File Browser, `copy web` and `/api/health`. Check that `.env`, a local edit, and
paper state persist across stop/start. Route any Chrome or Playwright checks to Browser Testing.

`project.tf` and `project/` are template-specific. The remaining Terraform and shared scripts are
synchronized from `ai-dev-k8s` by `pnpm templates:sync`. CLI image digest updates include this profile.
