#!/bin/bash
# Start KasmVNC — virtual display + VNC + web viewer in one process

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${BROWSER_VIEWPORT:-1280x720}"
WEB_PORT=6080
LOG_DIR="$HOME/.local/share/browser-vision"
mkdir -p "$LOG_DIR" "$HOME/.vnc"

# Clean up any previous run
vncserver -kill ":${DISPLAY_NUM}" 2>/dev/null || true
sleep 0.5

# KasmVNC config
cat > "$HOME/.vnc/kasmvnc.yaml" << YAML
network:
  protocol: http
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

# Start KasmVNC
echo "Starting KasmVNC on :${DISPLAY_NUM}, web port ${WEB_PORT}..."
vncserver ":${DISPLAY_NUM}" \
  -geometry "$RESOLUTION" \
  -depth 24 \
  -websocketPort "${WEB_PORT}" \
  -disableBasicAuth \
  -SecurityTypes None \
  -sslOnly 0 \
  -select-de manual \
  -Log "*:stderr:30" \
  > "$LOG_DIR/kasmvnc.log" 2>&1

if [ $? -ne 0 ]; then
  echo "ERROR: KasmVNC failed to start:"
  cat "$LOG_DIR/kasmvnc.log" 2>/dev/null
  exit 1
fi

# Window manager
if command -v fluxbox &>/dev/null; then
  nohup fluxbox -display ":${DISPLAY_NUM}" > "$LOG_DIR/fluxbox.log" 2>&1 &
  disown $!
fi

echo "Browser vision: http://localhost:${WEB_PORT}"
echo "Browser vision server started successfully"
