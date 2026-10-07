# Workspace Template Profiles

Hive ships five deployable Coder templates for interactive work in the Kubernetes cluster. Templates
define the environment and capability boundary; tmux/TUI sessions remain the conversation boundary
inside each workspace.

## Catalog

| Template | Profile | Image variant | Surface | Default resources |
| --- | --- | --- | --- | --- |
| `ai-dev-k8s` | Development & orchestration | `cli` | TUI, VS Code, files | 2 CPU, 16 GiB RAM, 100 GiB home |
| `browser-testing` | Browser testing | `browser` | Chrome, Playwright, desktop | 4 CPU, 8 GiB RAM, 50 GiB home |
| `game-dev` | Game development | `game` | Unity, Blender, desktop | 6 CPU, 16 GiB RAM, 150 GiB home |
| `electronics` | Electronics | `electronics` | KiCad, desktop | 4 CPU, 8 GiB RAM, 100 GiB home |
| `infrastructure` | Infrastructure | `infrastructure` | Terraform, kubectl, Helm, Argo CD | 4 CPU, 8 GiB RAM, 75 GiB home |

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
| GitHub external authentication | Yes | Yes | Yes | Yes | Yes |
| code-server and File Browser | Yes | Yes | Yes | Yes | Yes |
| XFCE and KasmVNC | No | Yes | Yes | Yes | No |
| Chrome | No | Yes | Unity authentication | No | No |
| Playwright MCP | No | Yes | No | No | No |
| Unity Hub and Blender | No | No | Yes | No | No |
| KiCad | No | No | No | Yes | No |
| Terraform, kubectl, Helm, and Argo CD | No | No | No | No | Yes |

This is both a runtime and image boundary. For example, a CLI image does not merely hide the Desktop
link: it has no XFCE, KasmVNC, Chrome, Unity, Blender, or KiCad executable to launch. Negative smoke
tests enforce those exclusions for every image build.

The `browser` capability controls browser automation, MCP configuration, and screenshot/HTML helpers.
Game Development keeps that flag disabled while including Chrome for interactive Unity Hub sign-in.
Its image supplies system browser defaults and the `unityhub://` callback handler; user preferences
in the persistent home take precedence.

## Source layout

`templates/ai-dev-k8s` is the canonical Kubernetes scaffold. Browser Testing, Game Development,
Electronics, and Infrastructure contain synchronized Terraform and startup scripts plus their own:

- `profile.json` for image variant, capabilities, resources, and editor extensions
- `CLAUDE.md` for agent behavior and safety boundaries
- `WORKSPACE_ROUTING.md`, synchronized from `ai-dev-k8s`, for the shared catalog and TUI handoff
  contract
- `WORKSPACE.md` for the generated `~/README.md` quick start
- `repositories.txt` for the narrow first-start repository set
- `README.md` for operator-facing deployment notes

After changing canonical Terraform, routing guidance, or scripts, synchronize and verify every
profile:

```bash
pnpm templates:sync
pnpm templates:check
pnpm test:templates
```

Generated scaffold files are committed so every directory remains directly deployable with the Coder
CLI; the push worker does not need a build step or symlink support.

On every workspace start, Hive refreshes the template-managed global agent context at
`~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. Repository-local instruction files remain owned by
their repositories and layer on top of that workspace context. If an agent configuration directory
is itself a symlink, Hive warns and preserves it instead of writing through to the linked target.

## Codex Cloudflare authentication

On every workspace start, all five templates register `cloudflare-api` in
`~/.codex/config.toml` when that server is missing, using Cloudflare's official
`https://mcp.cloudflare.com/mcp` endpoint. Existing server settings, including a custom URL or
`enabled = false`, are preserved. This explicit registration makes the server available to
`codex mcp login` independently of the Cloudflare plugin.

After starting a workspace with the updated template, authenticate interactively:

```bash
codex mcp login cloudflare-api
```

Open the printed authorization URL in your browser and complete Cloudflare's OAuth flow. Startup
does not initiate login or wait for browser authorization. Invalid TOML or a table layout that
cannot accept the defaults is preserved with a warning for manual correction.

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

`docker/hive-base/Dockerfile` builds `cli`, `infrastructure`, `browser`, `game`, and `electronics`
variants. Pull-request CI builds every variant and verifies both required and forbidden commands.
After a change lands on `main`, the workflow pushes all five tested image variants and opens a
follow-up PR that pins the synchronized profiles to the digest for their variant.

When introducing a new variant, the profile keeps the variant matching its existing digest and
declares `pending_image_variant`. The digest workflow replaces the digest, promotes that pending
variant, and removes the marker in the same follow-up commit; no repository revision contains a
mismatched expected variant and image.

## Validation

Restricted Codex filesystem profiles require working nested namespaces and mount
operations. Use the on-demand **Codex restricted sandbox readiness** terminal app and
the [sandbox runbook](codex-restricted-sandbox.md) before enabling a node-local
AppArmor policy. A sandbox startup failure is not evidence of read isolation.
The policy opt-in remains disabled pending node-policy and canary validation.

Before publishing:

1. Run `pnpm templates:check` and `pnpm test:templates`.
2. Confirm each `profile.json` has the intended capabilities, image variant, resources, and profile
   ID.
3. Push the template and create a fresh workspace rather than relying only on an existing PVC.
4. Verify Coder SSH, the Hive TUI, agent login, declared apps, repository bootstrap, workspace
   discovery from `ai-dev-k8s`, and stop/start persistence.
5. Confirm excluded apps are absent: especially Desktop in CLI profiles, Chrome outside Browser
   Testing and Game Development, and Playwright outside Browser Testing.
6. Perform domain checks in the matching profile. GPU, physical electronics, and live infrastructure
   access remain explicit external capabilities rather than template assumptions.

## Scheduled workspace cache maintenance

Every profile includes a Coder agent script named **Daily development cache maintenance**.
It runs daily at 06:45 UTC while the workspace is running, using Coder's
[six-field script scheduler](https://registry.terraform.io/providers/coder/coder/2.18.0/docs/resources/script).
It does not require systemd or a separate cron daemon, run at startup, or block
login. A stopped workspace skips that occurrence and waits for the next schedule
after it starts.

The script calls `npm cache verify` as the workspace owner with low CPU priority
and a nine-minute execution limit (ten minutes for the whole Coder script). It
accepts only the standard `$HOME/.npm` directory and refuses symlinked caches or
redirected cache objects or logs. Npm verifies cached objects and removes its own garbage;
valid package data may remain, so reclaimed space can be zero. Git probe timeouts skip that
repository while maintenance continues. Discovery skips common generated trees (including
Unity `Library`, Python virtual environments, and Rust `target`) and stops after 5,000
directories or a 120-second cooperative time budget, leaving room in the 900-second
script window for the full 540-second npm verification allowance and completion reporting. Git probes use at most the remaining budget;
budget checks occur between directories and cache entries. Source and cache directories are streamed
without sorting or collecting all entries, with a shared limit of 50,000 inspected entries
(including metadata and unrelated files) in each phase per pass. Discovery retains only
the ancestor frontier rather than collecting complete child/file lists. A checkpoint in
`~/.cache/hive/turbo-prune-state.json` retains the depth-first directory frontier and
Linux directory cookies, so following runs seek directly past inspected entries without
replaying the prefix. Cookies are bound to the directory device/inode and reset when that
identity changes, on read errors, or at end of directory. Old entry-count checkpoints are
discarded. Completing discovery starts a fresh cycle to revisit entries affected by churn.
This uses the Linux/glibc workspace images; unsupported directory seeking skips that cache. Top-level project directories are
preserved even when named `build`, `target`, `dist`, or `Library`. Both `<hash>.tar` and `<hash>.tar.zst` archives are eligible. Candidates move into a private
quarantine directory and are checked against the validated inode, modification time, and size
before deletion. Changed candidates are restored without overwriting a newly published
archive; if restoration conflicts or fails, the quarantine copy is retained and reported.
Only archives are removed;
metadata and manifest sidecars remain untouched, including orphan sidecars, to protect active
readers and concurrent writers. Small metadata files therefore accumulate, while large archive
payloads are reclaimed. Filesystem errors skip
the affected entry or cache and allow other repositories and npm verification to continue. It removes at most 2,000 recognized Turborepo cache archives older than seven
days per run under `$HOME/projects`. It skips tracked cache directories, follows
no symlinked paths, and preserves recent or unrecognized files. Source files,
dependencies, worktrees, agent conversations, and PVCs are outside its scope.

Inspect the script's Coder logs for timestamps, before/after KiB, and failures.
The template change takes effect when a workspace is updated to the new template
version; merging alone does not update existing workspace builds. Review one
workspace's first run before updating the remaining profiles. Removing the script
resource stops future scheduled runs after the next workspace update.

Node image/log retention and Longhorn snapshot cleanup remain separate policies
in `k8s-cluster`. This script does not activate those policies or post Telegram
messages directly.

The software profile reserves two CPU cores and can burst to its unchanged
12-core limit. This replaces the previous six-core reservation after reviewing
seven days of cluster metrics (observed per-pod 95th percentiles up to 1.15 cores).
The lower reservation improves scheduler headroom; it does not guarantee
failover when memory, GPU placement or single-instance applications constrain it.
Existing workspaces receive the new request and cache schedule on their next
template update. Do not restart an active primary workspace without coordinating
its running sessions.
