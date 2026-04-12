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

# Copy image-baked xstartup (openbox + Obsidian autostart via KasmVNC session)
cp /etc/kasmvnc/xstartup "$HOME/.vnc/xstartup"
chmod 755 "$HOME/.vnc/xstartup"

# KasmVNC YAML config — use image default, override resolution if BROWSER_VIEWPORT is set
if [ -z "$BROWSER_VIEWPORT" ]; then
  cp /etc/kasmvnc/kasmvnc.yaml "$HOME/.vnc/kasmvnc.yaml"
else
  WIDTH=$(echo "$RESOLUTION" | cut -dx -f1)
  HEIGHT=$(echo "$RESOLUTION" | cut -dx -f2)
  sed "s/width: 1280/width: ${WIDTH}/; s/height: 720/height: ${HEIGHT}/" \
    /etc/kasmvnc/kasmvnc.yaml > "$HOME/.vnc/kasmvnc.yaml"
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
