# Triage: Obsidian not launched automatically on start

## Root Cause

Two compounding issues in `browser-serve.sh`:

1. **KasmVNC xstartup conflict**: KasmVNC is started with `-select-de manual`, which
   runs the default `~/.vnc/xstartup`. That script starts `twm` (a minimal WM).
   Then `browser-serve.sh` starts openbox/fluxbox *separately*, resulting in two
   window managers on the same display.

2. **Fluxbox fallback has no Obsidian launch**: The `elif fluxbox` branch in
   `browser-serve.sh` starts fluxbox but does nothing to launch Obsidian.
   Openbox natively sources `/etc/xdg/openbox/autostart` (which launches Obsidian),
   but fluxbox has no equivalent mechanism wired up.

On workspaces built from older images (before openbox was added to the Dockerfile),
only fluxbox is available — so Obsidian never launches.

## Reproduction

- `ps aux | grep twm` → no twm (xstartup's twm was replaced by fluxbox)
- `ps aux | grep fluxbox` → running
- `ps aux | grep openbox` → not running (not installed)
- `ps aux | grep obsidian` → not running
- `cat ~/.local/share/browser-vision/obsidian.log` → file does not exist
- `/etc/xdg/openbox/autostart` → does not exist

## Affected Files

- `templates/*/scripts/browser-serve.sh` (4 identical copies)
- `docker/hive-base/openbox-autostart` (the Obsidian launch script — correct, but never sourced)

## Proposed Fix

Replace the default `~/.vnc/xstartup` at runtime in `browser-serve.sh` (before
starting KasmVNC) with a custom script that:

1. Starts openbox as the sole WM (or fluxbox as fallback)
2. For the fluxbox path, explicitly sources `/etc/xdg/openbox/autostart` so Obsidian launches
3. Removes the separate openbox/fluxbox start block from `browser-serve.sh`

This eliminates the dual-WM conflict and ensures Obsidian launches regardless of
which WM is available.
