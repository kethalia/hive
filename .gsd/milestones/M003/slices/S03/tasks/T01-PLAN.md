---
estimated_steps: 52
estimated_files: 1
skills_used: []
---

# T01: Add xterm and bake Openbox autostart + menu.xml into base Dockerfile

## Description

The base image already has Openbox installed but no config files — right-click does nothing and nothing autostarts. This task adds `xterm` to the apt layer and bakes two Openbox config files into `/etc/xdg/openbox/` using inline heredocs in the Dockerfile. System-wide config is correct here because user home is a Docker volume — image-layer config at `/etc/xdg/openbox/` always reflects the latest build.

This advances R037 (Obsidian autostart in every KasmVNC session) and R036 (right-click XML app launcher menu).

## Steps

1. Open `docker/hive-base/Dockerfile`. Find the apt layer that installs `openbox` (the Google Chrome + KasmVNC layer). Add `xterm` to the package list in that same `apt-get install` call.

2. After the `USER coder` line, find a suitable location BEFORE `USER coder` (must be root to write to `/etc/xdg/`). Insert a new block that creates `/etc/xdg/openbox/` and writes `autostart` and `menu.xml` using inline heredocs:

```dockerfile
# Bake Openbox desktop config (system-wide — survives volume mounts on /home/coder)
RUN mkdir -p /etc/xdg/openbox \
    && cat > /etc/xdg/openbox/autostart << 'XDGEOF'
# Autostart Obsidian with vault
/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault &
XDGEOF
    && cat > /etc/xdg/openbox/menu.xml << 'XDGEOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Desktop">
    <item label="Obsidian">
      <action name="Execute">
        <command>/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault</command>
      </action>
    </item>
    <item label="Terminal">
      <action name="Execute">
        <command>xterm</command>
      </action>
    </item>
  </menu>
</openbox_menu>
XDGEOF
    && chmod 644 /etc/xdg/openbox/autostart /etc/xdg/openbox/menu.xml
```

3. **Critical placement:** This block MUST be placed before the `USER coder` line (needs root to write to /etc/xdg/) but after openbox is installed.

4. **Key constraints:**
   - Use absolute path `/home/coder/vault` not `~/vault` — tilde doesn't expand in Openbox autostart
   - Obsidian needs `--no-sandbox --disable-gpu-sandbox` (Electron in Docker)
   - Use `'XDGEOF'` (quoted) heredoc delimiter so no shell variable expansion occurs
   - The `&` at end of obsidian line in autostart is critical — Openbox autostart blocks on foreground processes

## Must-Haves

- [ ] `xterm` added to the apt-get install layer alongside openbox
- [ ] `/etc/xdg/openbox/autostart` created with Obsidian launch command using absolute path and --no-sandbox flags
- [ ] `/etc/xdg/openbox/menu.xml` created with Obsidian and Terminal entries
- [ ] Both config files placed BEFORE `USER coder` line
- [ ] Both config files chmod 644

## Verification

- `grep -q 'xterm' docker/hive-base/Dockerfile`
- `grep -q 'obsidian --no-sandbox' docker/hive-base/Dockerfile`
- `grep -q '/etc/xdg/openbox/autostart' docker/hive-base/Dockerfile`
- `grep -q '/etc/xdg/openbox/menu.xml' docker/hive-base/Dockerfile`
- `grep -q 'root-menu' docker/hive-base/Dockerfile`
- `grep -q '/home/coder/vault' docker/hive-base/Dockerfile`
- Verify the openbox config block appears before `USER coder`: the line number of 'xdg/openbox' should be less than the line number of 'USER coder'

## Inputs

- ``docker/hive-base/Dockerfile` — current base image with Obsidian, openbox, notesmd-cli already installed; needs xterm and Openbox config additions`

## Expected Output

- ``docker/hive-base/Dockerfile` — updated with xterm in apt layer, /etc/xdg/openbox/autostart and menu.xml baked in via heredocs`

## Verification

grep -q 'xterm' docker/hive-base/Dockerfile && grep -q 'obsidian --no-sandbox' docker/hive-base/Dockerfile && grep -q 'root-menu' docker/hive-base/Dockerfile && grep -q '/home/coder/vault' docker/hive-base/Dockerfile && test $(grep -n 'xdg/openbox' docker/hive-base/Dockerfile | head -1 | cut -d: -f1) -lt $(grep -n 'USER coder' docker/hive-base/Dockerfile | head -1 | cut -d: -f1)
