#!/bin/bash
# Start KasmVNC — virtual display + VNC + web viewer in one process
#
# KasmVNC replaces Xvfb + x11vnc + websockify + noVNC.
# This script must return quickly — Coder treats long-running startup scripts
# as stuck even with start_blocks_login=false.
#
# Static config (xstartup, kasmvnc.yaml) is baked into the Docker image at
# /etc/kasmvnc/. We copy it to ~/.vnc/ at runtime because /home/coder is a
# Docker volume mount that masks image-layer files.

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${BROWSER_VIEWPORT:-1280x720}"
WEB_PORT=6080
LOG_DIR="$HOME/.local/share/browser-vision"
mkdir -p "$LOG_DIR" "$HOME/.vnc"

# Clean up any previous run
vncserver -kill ":${DISPLAY_NUM}" 2>/dev/null || true
sleep 0.5

# Set a dummy VNC password (KasmVNC requires one to exist even if auth is off)
echo -e "kasmvnc\nkasmvnc\n" | vncpasswd -u "$USER" -w -r 2>/dev/null || true

# Copy image-baked xstartup, or generate inline fallback for older images
if [ -f /etc/kasmvnc/xstartup ]; then
  cp /etc/kasmvnc/xstartup "$HOME/.vnc/xstartup"
else
  echo "WARNING: /etc/kasmvnc/xstartup not found — using inline fallback (rebuild Docker image)" >&2
  cat > "$HOME/.vnc/xstartup" <<'XSTARTUP'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
[ -r "$HOME/.Xresources" ] && xrdb "$HOME/.Xresources"
if command -v openbox >/dev/null 2>&1; then
  exec openbox --sm-disable
elif command -v fluxbox >/dev/null 2>&1; then
  [ -f /etc/xdg/openbox/autostart ] && . /etc/xdg/openbox/autostart
  exec fluxbox
else
  echo "ERROR: No window manager found (tried openbox, fluxbox)" >&2
  sleep infinity
fi
XSTARTUP
fi
chmod 755 "$HOME/.vnc/xstartup"

# KasmVNC YAML config — use image default, override resolution if BROWSER_VIEWPORT is set
if [ -f /etc/kasmvnc/kasmvnc.yaml ]; then
  if [ -z "$BROWSER_VIEWPORT" ]; then
    cp /etc/kasmvnc/kasmvnc.yaml "$HOME/.vnc/kasmvnc.yaml"
  else
    WIDTH=$(echo "$RESOLUTION" | cut -dx -f1)
    HEIGHT=$(echo "$RESOLUTION" | cut -dx -f2)
    if echo "$RESOLUTION" | grep -qE '^[0-9]+x[0-9]+$'; then
      sed "s/width: 1280/width: ${WIDTH}/; s/height: 720/height: ${HEIGHT}/" \
        /etc/kasmvnc/kasmvnc.yaml > "$HOME/.vnc/kasmvnc.yaml"
    else
      echo "WARNING: Invalid BROWSER_VIEWPORT format '${RESOLUTION}' — expected WIDTHxHEIGHT, using default" >&2
      cp /etc/kasmvnc/kasmvnc.yaml "$HOME/.vnc/kasmvnc.yaml"
    fi
  fi
else
  echo "WARNING: /etc/kasmvnc/kasmvnc.yaml not found — generating inline fallback" >&2
  cat > "$HOME/.vnc/kasmvnc.yaml" <<YAML
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
    width: $(echo "$RESOLUTION" | cut -dx -f1)
    height: $(echo "$RESOLUTION" | cut -dx -f2)
  allow_resize: true
YAML
fi

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
echo "Browser vision: http://localhost:${WEB_PORT}"
echo "Browser vision server started successfully"
