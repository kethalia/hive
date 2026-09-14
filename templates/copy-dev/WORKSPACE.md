# COPY development

Your repository is at `~/projects/lunarresearcher/copy`. Open that folder in the Hive TUI to work
with Codex or Claude Code. VS Code opens the repository directly.

## Run COPY

The `copy` command works from any directory:

```bash
copy terminal --demo  # Replay from the bundled snapshot
copy terminal         # Interactive terminal with provider refresh
copy hunt             # Scrolling decision feed
copy paper            # Paper engine
copy doctor --probe   # Provider and chain diagnostics; uses network access
copy web              # Optional web wrapper on port 8787
```

After `copy web`, open **COPY Web (run copy web)** in Coder. The link is private to the workspace
owner. Keep `PORT=8787` in `.env` when using this link. Browser automation and screenshots run in
the Browser Testing workspace.

## Develop

```bash
cd ~/projects/lunarresearcher/copy
npm test
codex
```

Node.js 24, npm, pnpm, Yarn, Bun, Foundry, GitHub CLI, Claude Code, Codex, code-server, File Browser,
and tmux are available. Dependencies install during setup with lifecycle scripts disabled.
If a future dependency needs a build script, run the required install/build command interactively.

## Configuration and persistence

Setup creates a private `.env` from upstream's `.env.example` only when none exists. Edit it in the
workspace to configure ReplyNodes or a Fomo session and your Robinhood RPC endpoints. Native executor
fields start blank. No COPY process starts automatically.

The 25 GiB persistent home retains the checkout, `.env`, `data/runtime.json` (CLI rules and paper
positions), `data/cache.json` (web cache and queue), and agent settings across stop/start cycles.
Startup does not pull or reset an existing checkout. Update the repository when you choose.

If repository bootstrap fails, fix GitHub external authentication, then run:

```bash
~/clone-repositories.sh
~/.local/libexec/hive-project-setup
```
