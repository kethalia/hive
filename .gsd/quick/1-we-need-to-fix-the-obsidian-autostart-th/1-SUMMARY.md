# Quick Task: Fix Obsidian autostart on workspace start

**Date:** 2026-04-12
**Branch:** main

## What Changed

- **Use openbox autostart properly** — write the vault-wait + Obsidian launcher to `~/.config/openbox/autostart` (user-level, no sudo) before starting openbox, then let openbox source it naturally after the display is ready.
- **Removed the sabotage** — prior code wrote a comment to `/etc/xdg/openbox/autostart`, actively disabling the mechanism, then raced Obsidian against openbox startup in a manual background subshell.
- The launcher is backgrounded with `&` in the autostart file as required by openbox autostart semantics.
- Display is guaranteed ready when the autostart runs — eliminates the timing race.
- All container flags retained: `--no-sandbox --disable-gpu --disable-dev-shm-usage`.

## Files Modified

- `templates/ai-dev/scripts/browser-serve.sh`
- `templates/hive-worker/scripts/browser-serve.sh`
- `templates/hive-council/scripts/browser-serve.sh`
- `templates/hive-verifier/scripts/browser-serve.sh`

## Verification

- `~/.config/openbox/autostart` is written before `openbox --sm-disable` is launched — no race.
- Launcher is backgrounded (`&`) per openbox autostart docs.
- Vault-wait loop (60 s) and `obsidian.json` registration preserved.
- No sudo required (user-level config path).
- Obsidian launch log: `~/.local/share/browser-vision/obsidian.log`
