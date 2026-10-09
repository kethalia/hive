# Hive Workspace Routing

Hive is a multi-workspace Coder system. Every workspace runs in the Kubernetes cluster, and each
template is an explicit capability boundary rather than a package-installation suggestion.

## Workspace catalog

- `ai-dev-k8s` (`HIVE_WORKSPACE_PROFILE=software`) is the persistent development and orchestration
  workspace. It owns the main repository clones and worktrees, CLI implementation, Codex and Claude
  Code sessions, and Coder workspace lifecycle operations. It has no desktop or browser runtime.
- `browser-testing` (`HIVE_WORKSPACE_PROFILE=browser`) owns Chrome, Playwright, screenshots, traces,
  accessibility inspection, and headed browser debugging through Coder Desktop.
- `game-dev` (`HIVE_WORKSPACE_PROFILE=game`) owns Unity, Blender, game assets, and desktop visual
  iteration. It includes Chrome for interactive Unity Hub authentication. GPU access is not
  guaranteed.
- `electronics` (`HIVE_WORKSPACE_PROFILE=electronics`) owns KiCad, electronics design files, and
  desktop design review. Physical USB and serial hardware are not available by default.
- `infrastructure` (`HIVE_WORKSPACE_PROFILE=infrastructure`) owns Terraform, kubectl, Helm, Argo CD,
  and infrastructure repositories. Tooling does not imply credentials or permission to mutate a
  live environment.

## Routing contract

Before acting on a capability-sensitive request, identify the current profile from
`HIVE_WORKSPACE_PROFILE`, `HIVE_IMAGE_VARIANT`, or `~/README.md`. Do not infer workspace capabilities
from the checked-out repository or the requested task.

When a required capability belongs to another profile, stop before trying to recreate that profile
locally. In particular, outside `browser-testing` do not download a replacement browser, run
Playwright browser or system-dependency installers, use `sudo` or `apt` to add browser libraries, or
rely on a Docker socket as a browser fallback. Route the browser step to `browser-testing` instead.

The Chrome included in `game-dev` supports interactive Unity Hub authentication in that workspace's
desktop, including the `unityhub://` callback. Keep this sign-in flow in `game-dev`; browser
automation, screenshots, traces, and web validation still belong in `browser-testing`.

Only `ai-dev-k8s` orchestrates workspaces. From that profile, inspect `coder templates list` and
`coder list`, reuse a healthy matching workspace when possible, and create or start one only when
needed. Record whether the workspace was reused or created as disposable for the task. After
preparing a specialist workspace, keep the interaction in Hive's TUI: tell the user which workspace
to open and provide the handoff below so questions and corrections stay interactive.

After a specialist task finishes, preserve its changes and evidence in the primary workspace before
cleanup. Only `ai-dev-k8s` performs cleanup:

- Do not stop or delete a workspace still serving another active task.
- Stop the specialist workspace once it is no longer in use.
- Automatic deletion is preauthorized only for disposable workspaces created for the completed task.
  Delete those workspaces after stopping them; no additional confirmation is required.
- Reused or persistent specialist workspaces must be retained after stopping. Deleting them requires
  explicit user confirmation of the exact target. If workspace provenance is unknown, retain it.
- Preserve the primary workspace and unrelated persistent resources; deleting those requires explicit
  user confirmation of the exact target.

Specialist agents return a completion handoff to `ai-dev-k8s` with the workspace name, whether it was
reused or created as disposable, and the location of preserved changes and evidence for cleanup.

Specialist profiles do not create, start, stop, or delete other workspaces. If work falls outside the
current profile, preserve the current state and return this handoff to the user or the agent running
in `ai-dev-k8s`:

```text
Workspace handoff required
- Target template: <template>
- Reason: <missing capability>
- Repository/path: <repository, branch, commit, and path or target URL>
- Current state: <completed work, evidence, and relevant artifacts>
- Next action: <specific interactive step to continue in the target workspace>
```

Keep implementation in the workspace that owns the repository unless the task explicitly moves it.
Use the specialist workspace for its bounded validation or tool step, then carry the resulting
evidence or changes back through the repository and the live TUI conversation. Do not use retired
Hive Tasks or New Task workflows for handoffs.

## Repository and task storage lifecycle

Keep one primary clone at `~/projects/<owner>/<repo>`. Reuse the primary checkout for sequential
work when no other task is using it, or reuse the existing checkout for the same task. Create a
worktree only when concurrent work or a clean validation requires isolation. Do not create a fresh
clone or a second worktree just to resume a task. In the software workspace, use:

```bash
hive-worktree create ~/projects/<owner>/<repo> <task> --branch <branch>
```

This groups task checkouts at `~/projects/<owner>/.worktrees/<repo>/<task>`. Install dependencies
only when the task needs them, using the repository's pinned package manager and lockfile. Keep
pnpm's store on the home filesystem so package files can be shared. Do not copy `node_modules`,
build caches, or generated assets into new task checkouts. For code-only validation, avoid checking
out large unrelated assets where the repository supports sparse checkouts.
Keep scratch output inside the task checkout or `/tmp`, rather than creating per-session folders
directly under the home directory. Move required evidence into the repository before task cleanup.

After the task is finished and required work is committed, return to the primary directory and run
`hive-worktree complete <task-path>`. This removes the task checkout and its recognized generated
directories when no process references it; committed branches remain in the primary repository.
Close or move idle terminals whose working directory is the finished checkout. If cleanup is
deferred, the software workspace retries explicitly completed tasks daily at 06:55 UTC.

Existing worktrees can be enrolled with `hive-worktree adopt <primary-repo> <task-path>` after
checking task ownership. Adoption alone does not authorize deletion. Never mark an ongoing task
completed. Cleanup skips source changes, untracked files, ignored files outside recognized generated
directories, changed branches or HEADs, locked worktrees, nested repositories, and filesystem mounts.
It never deletes primary clones, unmanaged worktrees, or committed branches based on age.

`~/repositories.txt` is seeded only when absent and remains user-owned afterward. Removing an entry
prevents startup from recreating that clone. Template updates do not append newly configured default
repositories to an existing manifest; add desired repositories explicitly.

## Git And PR Workflow

- Use Conventional Commits for every commit title and every PR title, for example
  `feat(terminal): add shared session frame`.
- Open a PR as a draft only when the goal or task is still running and work remains in progress.
  If the work is complete when the PR is opened, open it ready for review.
- When a goal or task finishes, mark any associated draft PRs ready for review before handing
  the completed work back to the user.
