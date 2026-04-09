#!/bin/bash
# Start KasmVNC — virtual display + VNC + web viewer in one process
#
# KasmVNC replaces Xvfb + x11vnc + websockify + noVNC.
# This script must return quickly — Coder treats long-running startup scripts
# as stuck even with start_blocks_login=false.

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${BROWSER_VIEWPORT:-1280x720}"
WIDTH=$(echo "$RESOLUTION" | cut -dx -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -dx -f2)
WEB_PORT=6080
LOG_DIR="$HOME/.local/share/browser-vision"
mkdir -p "$LOG_DIR" "$HOME/.vnc"

# Clean up any previous run
vncserver -kill ":${DISPLAY_NUM}" 2>/dev/null || true
sleep 0.5

# Set a dummy VNC password (KasmVNC requires one to exist even if auth is off)
echo -e "kasmvnc\nkasmvnc\n" | vncpasswd -u "$USER" -w -r 2>/dev/null || true

# KasmVNC YAML config — this is the primary way to configure KasmVNC
cat > "$HOME/.vnc/kasmvnc.yaml" << YAML
network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: ${WEB_PORT}
  udp:
    public_ip: 127.0.0.1
  ssl:
    require_ssl: false
    pem_certificate:
    pem_key:
desktop:
  resolution:
    width: ${WIDTH}
    height: ${HEIGHT}
  allow_resize: true
YAML

# Start KasmVNC with minimal flags — let the YAML handle the rest
echo "Starting KasmVNC on :${DISPLAY_NUM}, web port ${WEB_PORT}..."
vncserver ":${DISPLAY_NUM}" \
  -geometry "${RESOLUTION}" \
  -depth 24 \
  -disableBasicAuth \
  -select-de manual \
  > "$LOG_DIR/kasmvnc.log" 2>&1

RC=$?
if [ $RC -ne 0 ]; then
  echo "WARNING: KasmVNC failed to start (exit $RC):"
  cat "$LOG_DIR/kasmvnc.log" 2>/dev/null
  echo "Browser vision server failed — browser viewing will be unavailable"
  exit 0
fi

echo "KasmVNC started on :${DISPLAY_NUM}"

# Write autostart and menu — overrides anything baked into the image
AUTOSTART=/etc/xdg/openbox/autostart
MENU=/etc/xdg/openbox/menu.xml

sudo tee "$AUTOSTART" > /dev/null << 'AUTOEOF'
#!/bin/bash
# Wait up to 10s for vault to be cloned
(
  for i in $(seq 1 20); do
    if [ -d /home/coder/vault/.git ] || [ -d /home/coder/vault/.obsidian ]; then
      break
    fi
    sleep 0.5
  done

  # Register the vault in Obsidian's config so it opens directly
  OBSIDIAN_CFG="$HOME/.config/obsidian/obsidian.json"
  VAULT_ID="$(echo /home/coder/vault | md5sum | cut -c1-16)"
  if [ -d /home/coder/vault ]; then
    mkdir -p "$HOME/.config/obsidian"
    python3 -c "
import json, os, sys
cfg_path = os.path.expanduser('~/.config/obsidian/obsidian.json')
try:
    cfg = json.load(open(cfg_path))
except:
    cfg = {}
vaults = cfg.get('vaults', {})
vault_id = '$(echo /home/coder/vault | md5sum | cut -c1-16)'
vaults[vault_id] = {'path': '/home/coder/vault', 'ts': 0, 'open': True}
cfg['vaults'] = vaults
json.dump(cfg, open(cfg_path, 'w'))
print('Vault registered in Obsidian config')
" 2>/dev/null || true
  fi

  /usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault
) &
AUTOEOF
sudo chmod 755 "$AUTOSTART"

sudo tee "$MENU" > /dev/null << 'MENUEOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Desktop">
    <item label="Obsidian">
      <action name="Execute">
        <command>/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault</command>
      </action>
    </item>
    <item label="Chrome">
      <action name="Execute">
        <command>/usr/bin/google-chrome-stable --no-sandbox --disable-gpu-sandbox</command>
      </action>
    </item>
    <item label="Terminal">
      <action name="Execute">
        <command>xterm</command>
      </action>
    </item>
  </menu>
</openbox_menu>
MENUEOF
sudo chmod 644 "$MENU"

# Start Openbox window manager
if command -v openbox &>/dev/null; then
  DISPLAY=":${DISPLAY_NUM}" nohup openbox --startup "$AUTOSTART" \
    > "$LOG_DIR/openbox.log" 2>&1 &
  disown $!
  echo "Openbox window manager started"
elif command -v fluxbox &>/dev/null; then
  nohup fluxbox -display ":${DISPLAY_NUM}" > "$LOG_DIR/fluxbox.log" 2>&1 &
  disown $!
fi

echo "Browser vision: http://localhost:${WEB_PORT}"
echo "Browser vision server started successfully"
