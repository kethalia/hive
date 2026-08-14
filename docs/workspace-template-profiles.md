# Workspace Template Profiles

Hive ships deployable Coder templates for each interactive workspace use case. Templates define the
environment and context boundary; tmux/TUI sessions remain the conversation boundary inside them.

## Catalog

| Template | Profile | Runtime | Default resources |
| --- | --- | --- | --- |
| `orchestrator` | Orchestrator | Kubernetes | 4 CPU, 8 GiB RAM, 50 GiB home |
| `ai-dev` | Software development | Docker | Host-configured |
| `ai-dev-k8s` | Software development | Kubernetes | 6 CPU, 16 GiB RAM, 100 GiB home |
| `game-dev` | Game development | Kubernetes | 6 CPU, 16 GiB RAM, 150 GiB home |
| `electronics` | Electronics | Kubernetes | 4 CPU, 8 GiB RAM, 100 GiB home |
| `infrastructure` | Infrastructure | Kubernetes | 4 CPU, 8 GiB RAM, 75 GiB home |

The Kubernetes variants share the same digest-pinned `hive-base` image. This keeps deployment and
node-layer caching efficient while the template overlays specialize resource sizing, editor
extensions, repository bootstrap, home documentation, and agent instructions.

## Source layout

`templates/ai-dev-k8s` is the canonical Kubernetes scaffold. The four specialist directories contain
byte-identical Terraform and startup scripts plus their own:

- `profile.json` for image, resources, editor extensions, and optional tool surfaces
- `CLAUDE.md` for agent behavior and safety boundaries
- `WORKSPACE.md` for the generated `~/README.md` quick start
- `repositories.txt` for the narrow first-start repository set
- `README.md` for operator-facing deployment notes

After changing the canonical Terraform or scripts, synchronize and verify every specialist template:

```bash
pnpm templates:sync
pnpm templates:check
pnpm test:templates
```

Generated scaffold files are committed so every directory remains directly deployable with the Coder
CLI; the push worker does not need a build step or symlink support.

## Publish

Authenticate the Coder CLI, then push every template from the repository root:

```bash
coder templates push ai-dev --directory templates/ai-dev --yes
coder templates push ai-dev-k8s --directory templates/ai-dev-k8s --yes
coder templates push orchestrator --directory templates/orchestrator --yes
coder templates push game-dev --directory templates/game-dev --yes
coder templates push electronics --directory templates/electronics --yes
coder templates push infrastructure --directory templates/infrastructure --yes
```

The Hive Templates page exposes the same catalog and streams each push. A newly added template is
reported as stale until its first successful push.

## Base image rollout

Kubernetes profile configuration pins `ghcr.io/kethalia/hive-base` by digest. The base-image workflow
builds and smoke-tests the image, then opens a PR updating every Kubernetes `profile.json`. This keeps
specialist templates on one reviewed image revision.

## Validation

Before publishing:

1. Run `pnpm templates:check` and `pnpm test:templates`.
2. Confirm each `profile.json` has the intended resource envelope and profile ID.
3. Push the template and create a fresh workspace rather than relying only on an existing PVC.
4. Verify Coder SSH, the Hive TUI, agent login, editor apps, repository bootstrap, and stop/start
   persistence.
5. Perform domain checks in the matching profile. GPU, physical electronics, and live infrastructure
   access remain explicit external capabilities rather than template assumptions.
