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
  # Keep the script alive so Coder doesn't mark it as failed
  sleep infinity &
  wait
fi

# Kill any existing instances
pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
pkill -f "fluxbox" 2>/dev/null || true
pkill -f "x11vnc.*:${DISPLAY_NUM}" 2>/dev/null || true
pkill -f "websockify.*${NOVNC_PORT}" 2>/dev/null || true
sleep 1

# Start Xvfb (virtual framebuffer)
Xvfb ":${DISPLAY_NUM}" -screen 0 "${RESOLUTION}x24" -ac +extension GLX +render -noreset \
  > "$LOG_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1

# Verify Xvfb started
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "ERROR: Xvfb failed to start. Check $LOG_DIR/xvfb.log"
  cat "$LOG_DIR/xvfb.log" 2>/dev/null || true
  sleep infinity &
  wait
fi
echo "Xvfb started on display :${DISPLAY_NUM} (pid $XVFB_PID)"

# Start fluxbox (lightweight window manager)
fluxbox -display ":${DISPLAY_NUM}" \
  > "$LOG_DIR/fluxbox.log" 2>&1 &
echo "fluxbox started (pid $!)"
sleep 1

# Start x11vnc (VNC server attached to Xvfb)
x11vnc -display ":${DISPLAY_NUM}" -rfbport "${VNC_PORT}" \
  -nopw -shared -forever -noxdamage -noxfixes \
  > "$LOG_DIR/x11vnc.log" 2>&1 &
X11VNC_PID=$!
sleep 1

if ! kill -0 "$X11VNC_PID" 2>/dev/null; then
  echo "WARNING: x11vnc failed to start. Check $LOG_DIR/x11vnc.log"
  cat "$LOG_DIR/x11vnc.log" 2>/dev/null || true
fi

# Determine noVNC web directory
NOVNC_DIR=""
for dir in /usr/share/novnc /usr/share/novnc/utils/.. /opt/novnc; do
  if [ -d "$dir" ]; then
    if [ -f "$dir/vnc.html" ] || [ -f "$dir/vnc_lite.html" ]; then
      NOVNC_DIR="$dir"
      break
    fi
  fi
done

if [ -z "$NOVNC_DIR" ]; then
  NOVNC_DIR=$(find /usr/share -maxdepth 2 -name "vnc.html" -printf "%h\n" 2>/dev/null | head -1)
fi

if [ -z "$NOVNC_DIR" ]; then
  echo "WARNING: noVNC web directory not found"
  echo "VNC is still accessible directly on port ${VNC_PORT}"
  # Keep alive — VNC still works even without the web UI
  wait
fi

# Start noVNC (WebSocket proxy for web browser access)
websockify --web="$NOVNC_DIR" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
  > "$LOG_DIR/novnc.log" 2>&1 &
NOVNC_PID=$!
sleep 1

if kill -0 "$NOVNC_PID" 2>/dev/null; then
  echo "Browser vision web UI running:"
  echo "  noVNC:   http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=true&resize=remote"
  echo "  VNC:     localhost:${VNC_PORT}"
  echo "  Display: ${DISPLAY}"
  echo "  Logs:    ${LOG_DIR}/"
else
  echo "WARNING: websockify failed to start. Check $LOG_DIR/novnc.log"
  cat "$LOG_DIR/novnc.log" 2>/dev/null || true
fi

# Keep script alive (Coder marks non-blocking scripts as failed if they exit)
wait
