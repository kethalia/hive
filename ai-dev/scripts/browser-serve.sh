#!/bin/bash
# Start headless browser environment with noVNC web access
# This lets users watch AI agents interact with the browser in real-time

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${BROWSER_VIEWPORT:-1280x720}"
VNC_PORT=5999
NOVNC_PORT=6080
LOG_DIR="$HOME/.local/share/browser-vision"
WEB_DIR="$HOME/.local/share/browser-vision/web"
mkdir -p "$LOG_DIR" "$WEB_DIR"

# Check required commands
READY=true
for cmd in Xvfb fluxbox x11vnc; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Browser Vision Server: '$cmd' not found"
    READY=false
  fi
done

if [ "$READY" = "false" ]; then
  echo "Docker image needs rebuilding with the latest Dockerfile."
  echo "Browser vision web UI will not be available this session."
  exit 0
fi

# Kill any existing instances
MYPID=$$
for pattern in "Xvfb.*:${DISPLAY_NUM}" "fluxbox" "x11vnc.*:${DISPLAY_NUM}" "websockify.*${NOVNC_PORT}"; do
  pgrep -f "$pattern" 2>/dev/null | while read pid; do
    if [ "$pid" != "$MYPID" ] && [ "$pid" != "1" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
done
sleep 1

# Start Xvfb (virtual framebuffer)
nohup Xvfb ":${DISPLAY_NUM}" -screen 0 "${RESOLUTION}x24" -ac +extension GLX +render -noreset \
  > "$LOG_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
disown $XVFB_PID
sleep 1

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "ERROR: Xvfb failed to start. Check $LOG_DIR/xvfb.log"
  cat "$LOG_DIR/xvfb.log" 2>/dev/null || true
  exit 0
fi
echo "Xvfb started on display :${DISPLAY_NUM} (pid $XVFB_PID)"

# Start fluxbox (lightweight window manager)
nohup fluxbox -display ":${DISPLAY_NUM}" \
  > "$LOG_DIR/fluxbox.log" 2>&1 &
disown $!
echo "fluxbox started (pid $!)"
sleep 1

# Start x11vnc (VNC server attached to Xvfb)
nohup x11vnc -display ":${DISPLAY_NUM}" -rfbport "${VNC_PORT}" \
  -nopw -shared -forever -noxdamage -noxfixes \
  > "$LOG_DIR/x11vnc.log" 2>&1 &
X11VNC_PID=$!
disown $X11VNC_PID
sleep 1

if ! kill -0 "$X11VNC_PID" 2>/dev/null; then
  echo "WARNING: x11vnc failed to start. Check $LOG_DIR/x11vnc.log"
  cat "$LOG_DIR/x11vnc.log" 2>/dev/null || true
fi

# Install a known-working websockify from pip (system package has broken --web on Ubuntu 24.04)
echo "Installing websockify from pip..."
pip3 install --user --break-system-packages websockify 2>&1 | tail -1 || true

# Set up local noVNC web directory with index.html
NOVNC_SRC="/usr/share/novnc"
if [ ! -d "$NOVNC_SRC" ]; then
  echo "WARNING: noVNC not found at $NOVNC_SRC"
  echo "VNC is still accessible directly on port ${VNC_PORT}"
  exit 0
fi

# Symlink all noVNC files into our local web directory
for item in "$NOVNC_SRC"/*; do
  bn=$(basename "$item")
  rm -rf "$WEB_DIR/$bn"
  ln -sf "$item" "$WEB_DIR/$bn"
done

# Create index.html that redirects to vnc_lite.html (for root / requests)
cat > "$WEB_DIR/index.html" << 'INDEXHTML'
<!DOCTYPE html>
<html>
<head><meta http-equiv="refresh" content="0;url=vnc_lite.html?autoconnect=true&resize=remote"></head>
<body><a href="vnc_lite.html?autoconnect=true&resize=remote">Connect</a></body>
</html>
INDEXHTML

echo "Web directory: $WEB_DIR"
echo "Contents:"
ls "$WEB_DIR"/*.html 2>/dev/null || echo "  (no html files found!)"

# Choose websockify: prefer pip-installed version, then system
if [ -f "$HOME/.local/bin/websockify" ]; then
  WS_BIN="$HOME/.local/bin/websockify"
  echo "Using pip websockify: $WS_BIN"
elif command -v websockify &>/dev/null; then
  WS_BIN="websockify"
  echo "Using system websockify: $(which websockify)"
else
  echo "ERROR: websockify not found"
  exit 0
fi

# Start websockify with our local web directory
echo "Starting: $WS_BIN --web=$WEB_DIR $NOVNC_PORT localhost:$VNC_PORT"
nohup "$WS_BIN" --web="$WEB_DIR" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
  > "$LOG_DIR/novnc.log" 2>&1 &
NOVNC_PID=$!
disown $NOVNC_PID
sleep 2

if kill -0 "$NOVNC_PID" 2>/dev/null; then
  echo "Browser vision web UI running:"
  echo "  noVNC:   http://localhost:${NOVNC_PORT}/vnc_lite.html?autoconnect=true&resize=remote"
  echo "  VNC:     localhost:${VNC_PORT}"
  echo "  Display: ${DISPLAY}"
  echo "  Logs:    ${LOG_DIR}/"
  # Show websockify startup output
  cat "$LOG_DIR/novnc.log" 2>/dev/null || true
else
  echo "WARNING: websockify failed to start. Log output:"
  cat "$LOG_DIR/novnc.log" 2>/dev/null || true
fi

echo "Browser vision server started successfully"
