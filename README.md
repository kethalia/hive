# Hive

Hive brings terminals, Files, VS Code and desktop apps from your Coder environments into one
persistent workspace. Arrange windows in resizable Grid or Strip layouts, keep multiple boards,
and find sessions, repositories, apps and commands with Cmd/Ctrl+K.

## What you can do

- Keep persistent terminal sessions and resume native agent conversations in your Coder workspaces.
- Save multiple boards and arrange windows with resizable Grid or Strip layouts, stacks and tabs.
- Find terminals, repositories, files, workspace apps and commands through one launcher.
- Open Files, VS Code and desktop apps when the selected workspace template supports them.
- Receive agent questions, approvals and completion notifications, with controls for mobile use.

Closing a Hive window does not terminate its underlying tmux session. Boards are saved window
arrangements; Coder workspaces are the environments that run your tools.

## Getting started

Hive connects to an existing Coder deployment. Available apps and tools depend on the workspace
templates installed there; the bundled profiles separate software development, browser testing,
game development, electronics and infrastructure.

| Goal | Start here |
| --- | --- |
| Use an existing Hive deployment | Sign in with an allowed Coder deployment, open Cmd/Ctrl+K, and choose a terminal, project or app. See [window management](docs/window-management.md). |
| Configure Coder environments | Read the [workspace template profiles](docs/workspace-template-profiles.md) and optional [workspace Docker engine](docs/workspace-docker.md) guide. |
| Develop Hive locally | Use the pnpm version pinned in [package.json](package.json), install with `pnpm install --frozen-lockfile`, and configure [`.env.example`](.env.example). |
| Deploy or upgrade Hive | Follow the [deployment and rollback guide](docs/deployment.md). |

Local development needs PostgreSQL, Redis, the auth service and the terminal proxy alongside the
web app. The [development Compose file](docker-compose.dev.yml) supplies PostgreSQL and Redis on
host ports **47964** and **40744**; update `DATABASE_URL` and `REDIS_URL` to match when using it.
The web, auth and terminal processes must load the same `COOKIE_SECRET` and `AUTH_SERVICE_SECRET`.
Configure the allowed Coder deployment URLs and the terminal URL before testing sign-in or sessions.
See the [environment template](.env.example) for the remaining settings.

## Status and roadmap

Hive's current focus is the persistent developer workspace. Autonomous delivery is in development
and tracked separately in [#402](https://github.com/kethalia/hive/pull/402).

## Documentation

### Using Hive

- [Feature catalog and migration audit](docs/features.md)
- [Window management and keyboard shortcuts](docs/window-management.md)
- [Agent tools](docs/agent-tools.md) and [workspace agents](docs/workspace-agents.md)
- [Agent notifications](docs/agent-notifications.md)

### Configuring and deploying

- [Workspace template profiles](docs/workspace-template-profiles.md)
- [Workspace Docker engines](docs/workspace-docker.md)
- [Deployment](docs/deployment.md)

## Contributing

Development and validation follow [AGENTS.md](AGENTS.md). Browser evidence records its fixture,
source and limitations under [docs/checks](docs/checks/).
