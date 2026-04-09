---
id: T01
parent: S03
milestone: M003
key_files:
  - docker/hive-base/Dockerfile
key_decisions:
  - Used /etc/xdg/openbox/ (system-wide) not ~/.config/openbox/ so config survives /home/coder volume mounts
  - Quoted heredoc delimiter ('XDGEOF') prevents shell variable expansion during docker build
  - Absolute path /home/coder/vault used because tilde does not expand in Openbox autostart
duration: 
verification_result: passed
completed_at: 2026-04-09T16:18:31.786Z
blocker_discovered: false
---

# T01: Added xterm to openbox apt layer and baked /etc/xdg/openbox/autostart + menu.xml into base Dockerfile using heredocs before USER coder

**Added xterm to openbox apt layer and baked /etc/xdg/openbox/autostart + menu.xml into base Dockerfile using heredocs before USER coder**

## What Happened

Inspected docker/hive-base/Dockerfile, added xterm alongside openbox in the Chrome/KasmVNC apt layer, then inserted a new RUN block (as root, before USER coder) that creates /etc/xdg/openbox/ and writes both autostart (Obsidian backgrounded with --no-sandbox --disable-gpu-sandbox at absolute path /home/coder/vault) and menu.xml (Obsidian + Terminal right-click entries) using quoted heredocs to prevent shell expansion. System-wide placement survives /home/coder volume mounts.

## Verification

All 7 grep/line-number checks passed: xterm in apt layer, obsidian --no-sandbox present, both /etc/xdg/openbox/ paths present, root-menu XML id present, /home/coder/vault absolute path present, and openbox config block confirmed at line 132 before USER coder at line 167.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -q 'xterm' docker/hive-base/Dockerfile` | 0 | ✅ pass | 10ms |
| 2 | `grep -q 'obsidian --no-sandbox' docker/hive-base/Dockerfile` | 0 | ✅ pass | 5ms |
| 3 | `grep -q '/etc/xdg/openbox/autostart' docker/hive-base/Dockerfile` | 0 | ✅ pass | 5ms |
| 4 | `grep -q '/etc/xdg/openbox/menu.xml' docker/hive-base/Dockerfile` | 0 | ✅ pass | 5ms |
| 5 | `grep -q 'root-menu' docker/hive-base/Dockerfile` | 0 | ✅ pass | 5ms |
| 6 | `grep -q '/home/coder/vault' docker/hive-base/Dockerfile` | 0 | ✅ pass | 5ms |
| 7 | `test $(grep -n 'xdg/openbox' docker/hive-base/Dockerfile | head -1 | cut -d: -f1) -lt $(grep -n 'USER coder' docker/hive-base/Dockerfile | head -1 | cut -d: -f1)` | 0 | ✅ pass | 10ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `docker/hive-base/Dockerfile`
