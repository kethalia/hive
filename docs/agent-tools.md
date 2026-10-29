# Agent tools and session recovery

Open **Agents** from Cmd/Ctrl+K (or Cmd/Ctrl+Alt+A). It opens a resizable workspace
window with a Coder workspace selector and recent conversations first. **Agent setup
and integrations** expands installed CLI versions, sign-in, MCP configuration, plugins,
tracking hooks, and the TypeScript language server. Refresh updates the shared inventory;
reopening can reuse cached results. Only the Coder workspace owner can read this inventory
or change agent setup.

Connection inventories are limited to 200 entries per agent.

Configured does not mean connected. Use `/mcp` inside the relevant agent for live
connection status, reconnecting, OAuth, and project-specific or plugin-provided
tools. Codex hook trust remains in `/hooks`. Inventory never starts an MCP server,
changes approval rules, or automatically authenticates an account. Unsupported
CLI commands are reported as unavailable. An installed language-server binary and
plugin are prerequisites, not proof that a particular project has loaded its LSP.

Claude inventory combines its user configuration with the workspace-managed
`~/.claude/mcp.json` and `~/.mcp.json` files, plus `mcp.json` under a custom
`CLAUDE_CONFIG_DIR` when set. Duplicate server names appear once. Only names are
read into the inventory; server URLs, arguments, environment values, and headers
are excluded. An unreadable file produces a warning while other files remain
visible.

## Tracking and recovery

**Enable tracking** installs a local helper and merges lifecycle hooks into
Codex's `hooks.json` and Claude's `settings.json`. Existing settings and hooks,
including symlink targets and custom configuration directories, are preserved.
Restart agents afterward and review the new Codex hooks in `/hooks`. Tracking is
independent of push notifications. **Disable tracking** removes only these hooks;
restart agents to apply the change. Previously recorded sessions remain available.
Tracking setup and notification Connect/Reconnect share a configuration lock so
concurrent updates preserve both sets of hooks and unrelated user configuration.

Sessions appear after tracking is enabled. Existing conversations are recorded
when resumed in the native agent; Hive does not import or parse old transcripts.
The workspace keeps the latest 200 records in the private
`~/.local/share/hive/agents/sessions.json` file. Records contain agent/session IDs,
working directory, last lifecycle status/time, and process/pane identity. Prompts,
answers, tool inputs/results, credentials, and transcripts are never recorded by
this helper. The web application receives only the owner-visible inventory and
session metadata, with folders relative to the workspace home. It does not store
session history in Hive's database.

Search by project, folder, agent, or session ID. **Open** returns to an existing
Hive terminal. **Resume** starts `codex resume <id>` or `claude --resume <id>` in
the recorded directory in a dedicated tmux session. It does not inject text into
a running terminal. Repeated requests reuse the recovery terminal. Hive refuses
to duplicate a known running agent outside its terminal socket or to resume into
a missing directory or a directory outside the workspace home. Missing native
conversation data is handled by the native agent's resume interface.

Lifecycle status reflects the last observed hook. Ready does not guarantee that
the broader task is complete. Ended and failed states remain visible after process
exit; other inactive sessions appear as not running. The separate `running` flag
controls whether the panel offers Open or Resume. Process identity includes the
Linux boot ID and start time, so workspace restarts and PID reuse cannot keep an old process marked
running. Workspace shutdown ends terminals; the local session index survives on
the persistent home volume. Shell jobs and old terminal output are not restored.

## Software workspace integrations

**Connect Coder** adds `hive_coder` to the two agents' user MCP configuration, using
the installed `coder exp mcp server` and its native `--allowed-tools` capability.
It exposes workspace/template inspection, apps, and diagnostic logs. It excludes
workspace execution, writes, lifecycle mutations, and Coder Tasks. Existing
`hive_coder` entries, including user-disabled entries, are preserved. The native
CLI uses the software workspace's existing Coder login; no credential is copied
into MCP configuration. Specialist profiles cannot configure this integration.

Updated software templates also run an optional **Agent integrations** startup
script, without blocking terminal login. It seeds the same Coder connection,
installs `typescript-language-server@5.1.3` with `typescript@5.9.3` when the server
is absent, and attempts to install Anthropic's
`typescript-lsp@claude-plugins-official` when the plugin is absent. Existing
installed/disabled plugins are not reinstalled or enabled. If the official
marketplace is not yet available, finish setup in Claude's `/plugin` after its
first interactive launch. Failed optional installs leave the terminal usable and
can be retried with the commands in the panel. The template does not enable
session tracking.

No database migration or new public workspace listener is required. Deploy the
web release for the panel; roll out the software template for automatic integration
setup. The helper ships in Next's standalone output and executes over the existing
authenticated Coder SSH connection, so inventory and opt-in tracking work on
existing workspaces without a template rollout.

## Validation

- `python3 scripts/agents/test_agent_tools.py`
- `pnpm exec vitest run src/__tests__/lib/agents src/__tests__/components/agent-tools-panel.test.tsx`
- `pnpm test:templates`, `pnpm typecheck`, `pnpm check`, and `pnpm build`
- Build the UI fixture with `node scripts/agents/build-preview.mjs /tmp/hive-agent-tools-preview`.
  Transfer it to Browser Testing, serve on port 4187, and run `validate.mjs` using
  that workspace's Playwright package and Chrome. The fixture validates UI states
  and routing callbacks; native agent authentication/inference is not simulated.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Coder MCP](https://coder.com/docs/ai-coder/mcp-server),
[Claude code intelligence](https://code.claude.com/docs/en/plugins/code-intelligence).

## Neon integration

The software template seeds the official `https://mcp.neon.tech/mcp` endpoint in
Codex and Claude user configuration only when the `neon` entry is absent. Existing
entries, including disabled or customized endpoints, are preserved. Setup never
starts OAuth, creates API keys, or provisions a database. Restart the agent after
updating the workspace, then authenticate in the workspace terminal:

```sh
codex mcp login neon --no-browser
```

Open the printed authorization URL in your own browser. After sign-in, paste the
callback URL into that terminal's hidden input, even if its localhost page cannot
load. Do not paste credentials or callback URLs into chat. Authentication is
per-user and separate from the Neon app/plugin connection in the desktop app.
Verify access with a read-only project listing before performing database work.

The template also installs the vendor's `neon-postgres` skill from
[neondatabase/agent-skills](https://github.com/neondatabase/agent-skills), bootstrapped
at revision `9df568a3f88a361ea33db00453ff754d07b3b3e1`. Installation downloads bounded
skill data, validates archive paths, and preserves existing skill destinations.
It exposes managed skill data to the shared agents directory and Codex/Claude skill
roots, respecting custom configuration directories. A failed download leaves setup
retryable and does not block terminal login. This is a workspace template capability;
existing workspaces receive it after a template publication and update/start.

Neon's catalog plugin is an optional desktop connection; it cannot be silently
installed or authenticated into the user's desktop account by a Coder template.
The template provides the official skill and remote MCP integration for native CLIs.

## Scheduled official updates

The workspace template schedules official agent maintenance daily at 06:15 UTC
(08:15 in Bucharest during winter; 09:15 during summer). This uses Coder's agent
cron support, not an OS cron daemon. It runs only while the workspace is running;
a stopped workspace does not wake solely for maintenance. Existing startup setup
remains available when the workspace next starts.

The update allowlist covers Codex, Claude Code, the six existing OpenAI-curated /
Vercel skills, and the official Neon PostgreSQL skill in the software profile.
Updates do not authenticate accounts, provision resources, restart sessions, or
upgrade repository dependencies. Pinned TypeScript tooling and user-selected
plugins remain governed by template/native plugin updates, not this job.

The installer and scheduled maintenance serialize shared changes. Skill updates
stage vendor content and preserve user modifications and unmanaged destinations.
Tool upgrades are deferred while an agent is running. Inspect the maintenance
script output and `~/.local/state/hive/agent-updates/last-run.json` for update,
deferred, preserved, or failure results. A check does not guarantee that every
component was upgraded: offline sources, active agents, and user edits are
explicit reasons to defer. New versions take effect in later agent sessions.

Template publication/update is still required to activate this schedule in an
existing workspace. Updating source files in the repository alone does not
publish a template or change the running workspace's schedule.

Unchanged Codex versions are skipped and failed staging directories are removed.
Previous distinct successful managed versions are retained for recovery; this job
does not automatically delete historical tool versions. Review their disk usage
under the private agent-update state directory as part of workspace maintenance.
