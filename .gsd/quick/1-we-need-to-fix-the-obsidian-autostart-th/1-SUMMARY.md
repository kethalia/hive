# Quick Task: Fix Obsidian autostart and extract embedded config files

**Date:** 2026-04-12
**Branch:** main

## What Changed

### Obsidian autostart fix
- Root causes: missing `--disable-dev-shm-usage` (Electron silent crash with Docker's 64 MB /dev/shm), timing race on autostart write, stale Electron single-instance lock
- Fixed by using openbox's native autostart (`/etc/xdg/openbox/autostart`) — display is guaranteed ready before it runs, no race possible
- Removed all runtime autostart-writing logic from `browser-serve.sh` files

### Extracted standalone config files (Dockerfile + scripts → tracked files)
- `docker/hive-base/openbox-autostart` → `/etc/xdg/openbox/autostart` (vault-wait + Obsidian launch)
- `docker/hive-base/openbox-menu.xml` → `/etc/xdg/openbox/menu.xml`
- `docker/hive-base/openbox-debian-menu.xml` → `/var/lib/openbox/debian-menu.xml`
- `docker/hive-base/obsidian-launch` → `/usr/local/bin/obsidian-launch` (manual debug helper)
- `templates/ai-dev/CLAUDE.md` — extracted from init.sh heredoc, injected via templatefile()
- `templates/hive-council/CLAUDE.md` — extracted from init.sh heredoc, injected via templatefile()
- Dockerfile now uses `COPY` for all five files; no heredocs remain

## Files Modified
- `docker/hive-base/Dockerfile` — replaced heredocs with COPY directives
- `docker/hive-base/openbox-autostart` (new)
- `docker/hive-base/openbox-menu.xml` (new)
- `docker/hive-base/openbox-debian-menu.xml` (new)
- `docker/hive-base/obsidian-launch` (new)
- `templates/ai-dev/CLAUDE.md` (new)
- `templates/hive-council/CLAUDE.md` (new)
- `templates/ai-dev/main.tf` — added `claude_md_content` to templatefile() vars
- `templates/hive-council/main.tf` — added `claude_md_content` to templatefile() vars
- `templates/ai-dev/scripts/init.sh` — replaced CLAUDE.md heredoc with `${claude_md_content}`
- `templates/hive-council/scripts/init.sh` — replaced CLAUDE.md heredoc with `${claude_md_content}`
- `templates/ai-dev/scripts/browser-serve.sh` — removed autostart-writing block
- `templates/hive-council/scripts/browser-serve.sh` — removed autostart-writing block
- `templates/hive-worker/scripts/browser-serve.sh` — removed autostart-writing block
- `templates/hive-verifier/scripts/browser-serve.sh` — removed autostart-writing block

## Verification
- Dockerfile COPY directives verified against existing files in docker/hive-base/
- openbox-autostart contains vault-wait, Python vault registration, stale-lock cleanup, correct Electron flags
- CLAUDE.md content identical to prior heredoc content
- No runtime config writes remain for autostart or CLAUDE.md
