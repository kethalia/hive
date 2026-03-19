#!/bin/bash
# Start headless browser environment with noVNC web access
# This lets users watch AI agents interact with the browser in real-time

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${BROWSER_VIEWPORT:-1280x720}"
VNC_PORT=5999
NOVNC_PORT=6080
LOG_DIR="$HOME/.local/share/browser-vision"
mkdir -p "$LOG_DIR"

# Check required commands
READY=true
for cmd in Xvfb fluxbox x11vnc websockify; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Browser Vision Server: '$cmd' not found"
    READY=false
  fi
done

if [ "$READY" = "false" ]; then
  echo "Docker image needs rebuilding with the latest Dockerfile."
  echo "Browser vision web UI will not be available this session."
  echo "Headless mode (Playwright MCP) still works for AI agents."
  exit 0
fi

# Kill any existing instances (exclude our own PID to avoid self-kill)
MYPID=$$
for pattern in "Xvfb.*:${DISPLAY_NUM}" "fluxbox" "x11vnc.*:${DISPLAY_NUM}" "websockify.*${NOVNC_PORT}" "novnc_proxy"; do
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

# Verify Xvfb started
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

# Start noVNC web UI
# Try the official novnc_proxy launcher first (handles file serving correctly),
# then fall back to manual websockify
NOVNC_PROXY="/usr/share/novnc/utils/novnc_proxy"

if [ -x "$NOVNC_PROXY" ]; then
  echo "Starting noVNC via novnc_proxy..."
  nohup "$NOVNC_PROXY" --vnc "localhost:${VNC_PORT}" --listen "${NOVNC_PORT}" \
    > "$LOG_DIR/novnc.log" 2>&1 &
  NOVNC_PID=$!
  disown $NOVNC_PID
else
  echo "novnc_proxy not found, using websockify directly..."
  # Find noVNC web directory
  NOVNC_DIR=""
  for dir in /usr/share/novnc /opt/novnc; do
    if [ -d "$dir" ] && [ -f "$dir/vnc_lite.html" -o -f "$dir/vnc.html" ]; then
      NOVNC_DIR="$dir"
      break
    fi
  done

  if [ -z "$NOVNC_DIR" ]; then
    echo "WARNING: noVNC web directory not found"
    echo "VNC is still accessible directly on port ${VNC_PORT}"
    exit 0
  fi

  echo "noVNC web dir: $NOVNC_DIR"
  nohup websockify --web "$NOVNC_DIR" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
    > "$LOG_DIR/novnc.log" 2>&1 &
  NOVNC_PID=$!
  disown $NOVNC_PID
fi

sleep 2

if kill -0 "$NOVNC_PID" 2>/dev/null; then
  echo "Browser vision web UI running:"
  echo "  noVNC:   http://localhost:${NOVNC_PORT}/vnc_lite.html?autoconnect=true&resize=remote"
  echo "  VNC:     localhost:${VNC_PORT}"
  echo "  Display: ${DISPLAY}"
  echo "  Logs:    ${LOG_DIR}/"
else
  echo "WARNING: noVNC failed to start. Check $LOG_DIR/novnc.log"
  cat "$LOG_DIR/novnc.log" 2>/dev/null || true
fi

echo "Browser vision server started successfully"
