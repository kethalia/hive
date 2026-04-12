# Quick Task: Fix Obsidian autostart on workspace start

**Date:** 2026-04-12
**Branch:** main

## What Changed
- Created `docker/hive-base/openbox-autostart` — standalone shell file with vault-wait loop, obsidian.json registration, stale-lock cleanup, and Obsidian launch with correct Electron flags
- Created `docker/hive-base/openbox-menu.xml` — standalone XML for the desktop right-click menu (Obsidian, Chrome, Terminal)
- Created `docker/hive-base/openbox-debian-menu.xml` — standalone XML stub required by Debian's rc.xml to prevent g_spawn assertion crash on openbox startup
- Updated `docker/hive-base/Dockerfile` to `COPY` all three openbox config files from the build context; replaced inline heredocs with `COPY openbox-autostart`, `COPY openbox-menu.xml`, `COPY openbox-debian-menu.xml`
- Removed the runtime autostart-writing block from all 4 `browser-serve.sh` files

## Files Modified
- `docker/hive-base/openbox-autostart` (new)
- `docker/hive-base/openbox-menu.xml` (new)
- `docker/hive-base/openbox-debian-menu.xml` (new)
- `docker/hive-base/Dockerfile`
- `templates/ai-dev/scripts/browser-serve.sh`
- `templates/hive-council/scripts/browser-serve.sh`
- `templates/hive-worker/scripts/browser-serve.sh`
- `templates/hive-verifier/scripts/browser-serve.sh`

## Verification
- Dockerfile: COPY + chmod 755 verified via grep
- browser-serve.sh: no autostart-writing code remains — verified via grep
- Openbox sources /etc/xdg/openbox/autostart automatically after startup; file is baked into the image at build time, no runtime race possible
- All 4 template browser-serve.sh files synced
