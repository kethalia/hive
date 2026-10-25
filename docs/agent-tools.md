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
