# Workspace Template Profiles

Hive ships five deployable Coder templates for interactive work in the Kubernetes cluster. Templates
define the environment and capability boundary; tmux/TUI sessions remain the conversation boundary
inside each workspace.

## Catalog

| Template | Profile | Image variant | Surface | Default resources |
| --- | --- | --- | --- | --- |
| `ai-dev-k8s` | Development & orchestration | `cli` | TUI, VS Code, files | 6 CPU, 16 GiB RAM, 100 GiB home |
| `browser-testing` | Browser testing | `browser` | Chrome, Playwright, desktop | 4 CPU, 8 GiB RAM, 50 GiB home |
| `game-dev` | Game development | `game` | Unity, Blender, desktop | 6 CPU, 16 GiB RAM, 150 GiB home |
| `electronics` | Electronics | `electronics` | KiCad, desktop | 4 CPU, 8 GiB RAM, 100 GiB home |
| `infrastructure` | Infrastructure | `cli` | TUI, VS Code, files | 4 CPU, 8 GiB RAM, 75 GiB home |

There is no Docker-backed workspace template in the catalog. Every template provisions a non-root
Kubernetes Deployment and a persistent Longhorn home volume in the `coder` namespace.

## Capability boundaries

Each `profile.json` declares its image variant and explicit capabilities. Terraform uses those flags
to decide which Coder scripts, applications, and modules exist; the image build uses the variant to
decide which binaries are present.

| Capability | Development | Browser | Game | Electronics | Infrastructure |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Code, Codex, tmux, CLI baseline | Yes | Yes | Yes | Yes | Yes |
| Coder workspace orchestration | Yes | No | No | No | No |
| code-server and File Browser | Yes | Yes | Yes | Yes | Yes |
| XFCE and KasmVNC | No | Yes | Yes | Yes | No |
| Chrome and Playwright MCP | No | Yes | No | No | No |
| Unity Hub and Blender | No | No | Yes | No | No |
| KiCad | No | No | No | Yes | No |

This is both a runtime and image boundary. For example, a CLI image does not merely hide the Desktop
link: it has no XFCE, KasmVNC, Chrome, Unity, Blender, or KiCad executable to launch. Negative smoke
tests enforce those exclusions for every image build.

## Source layout

`templates/ai-dev-k8s` is the canonical Kubernetes scaffold. The four specialist directories
contain byte-identical Terraform and startup scripts plus their own:

- `profile.json` for image variant, capabilities, resources, and editor extensions
- `CLAUDE.md` for agent behavior and safety boundaries
- `WORKSPACE.md` for the generated `~/README.md` quick start
- `repositories.txt` for the narrow first-start repository set
- `README.md` for operator-facing deployment notes

After changing canonical Terraform or scripts, synchronize and verify every profile:

```bash
pnpm templates:sync
pnpm templates:check
pnpm test:templates
```

Generated scaffold files are committed so every directory remains directly deployable with the Coder
CLI; the push worker does not need a build step or symlink support.

## Publish

Authenticate the Coder CLI, then push every Kubernetes template from the repository root:

```bash
coder templates push ai-dev-k8s --directory templates/ai-dev-k8s --yes
coder templates push browser-testing --directory templates/browser-testing --yes
coder templates push game-dev --directory templates/game-dev --yes
coder templates push electronics --directory templates/electronics --yes
coder templates push infrastructure --directory templates/infrastructure --yes
```

The Hive Templates page exposes this same catalog and streams each push. A newly added template is
reported as stale until its first successful push.

## Retired orchestrator profile

`ai-dev-k8s` is the persistent command center because it owns the durable repository clones and
worktrees needed to understand and execute an objective. It can inspect, launch, resume, and stop
specialist workspaces while continuing to handle ordinary software implementation itself.

The former `orchestrator` source template is no longer published or offered in Hive's launch flow.
Hive still recognizes existing workspaces created from it as terminal-only, so this repository change
does not delete or mutate their Coder resources. An administrator can archive the remote template
after any required workspace migration is complete.

## Image rollout

`docker/hive-base/Dockerfile` builds `cli`, `browser`, `game`, and `electronics` variants. Pull-request
CI builds every variant and verifies both required and forbidden commands. After a change lands on
`main`, the workflow pushes all four tested images and opens a follow-up PR that pins each
`profile.json` to the digest for its variant.

## Validation

Before publishing:

1. Run `pnpm templates:check` and `pnpm test:templates`.
2. Confirm each `profile.json` has the intended capabilities, image variant, resources, and profile
   ID.
3. Push the template and create a fresh workspace rather than relying only on an existing PVC.
4. Verify Coder SSH, the Hive TUI, agent login, declared apps, repository bootstrap, workspace
   discovery from `ai-dev-k8s`, and stop/start persistence.
5. Confirm excluded apps are absent: especially Desktop in CLI profiles and Chrome/Playwright in
   every profile except Browser Testing.
6. Perform domain checks in the matching profile. GPU, physical electronics, and live infrastructure
   access remain explicit external capabilities rather than template assumptions.
