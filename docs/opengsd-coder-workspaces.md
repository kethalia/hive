# OpenGSD Coder Workspace Update

**Reader:** a Hive operator who maintains the Coder templates.

**Post-read action:** publish the OpenGSD template update, rebuild existing
workspaces, and verify that each workspace resolves the maintained `@opengsd`
packages instead of the abandoned pre-OpenGSD packages.

## What changed

The Coder templates now install the maintained OpenGSD packages:

- `@opengsd/get-shit-done-redux` for Claude Code slash commands and the
  `gsd-sdk`/`gsd-tools` shims used by hooks.
- `@opengsd/gsd-pi` for the standalone `gsd` and `gsd-cli` commands.

The templates uninstall the old packages first so stale `gsd` or `gsd-sdk` shims
cannot stay first on `PATH`.

## Publish updated templates

From a checkout of Hive with Coder CLI credentials configured:

```bash
coder templates push hive --directory templates/hive --yes \
  --message "Install OpenGSD packages"

coder templates push ai-dev --directory templates/ai-dev --yes \
  --message "Install OpenGSD packages"
```

If you use the Hive web UI template push workflow, push both known templates and
wait for each push stream to finish with `[exit:0]`.

## Update existing workspaces

Rebuild each workspace onto the active template version:

```bash
coder update <workspace-name>
```

`coder update` stops a running workspace if needed, applies the active template
version, runs the startup scripts, and starts it again.

## Repair a workspace without rebuilding

If a workspace cannot be rebuilt immediately, run this inside the workspace:

```bash
export PATH="$HOME/.local/bin:$PATH"
export npm_config_prefix="$HOME/.local"

npm uninstall -g \
  get-shit-done-cc \
  get-shit-done-redux \
  gsd-pi \
  @gsd-build/sdk \
  @gsd-redux/sdk \
  @gsd-redux/get-shit-done-redux \
  || true

npm install -g @opengsd/get-shit-done-redux@latest @opengsd/gsd-pi@latest
get-shit-done-redux --claude --global
```

## Verify each workspace

Inside the workspace:

```bash
which gsd
which gsd-sdk
gsd --version
npm list -g --depth=0 | grep '@opengsd'
```

Expected result:

- `gsd` resolves from the user-writable global npm prefix, normally
  `$HOME/.local/bin/gsd`.
- `gsd-sdk` resolves from the same prefix, normally `$HOME/.local/bin/gsd-sdk`.
- `npm list -g --depth=0` includes `@opengsd/gsd-pi` and
  `@opengsd/get-shit-done-redux`.
- Claude Code has GSD slash commands such as `/gsd-new-project` and
  `/gsd-progress` available after restart.

## Migrate legacy project state

For projects that still have legacy `.planning` artifacts from old GSD core,
open a GSD session in that project and run:

```text
/gsd migrate
/gsd doctor
```

`/gsd migrate` imports the old planning tree into the new `.gsd` structure and
`/gsd doctor` checks the migrated database and markdown projections.
