#!/bin/bash
# Start headless browser environment with web-based VNC access
# Lets users watch AI agents interact with the browser in real-time
#
# Preferred: KasmVNC (single process, replaces everything)
# Fallback:  Xvfb + x11vnc + websockify + noVNC (runtime-installed if needed)

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${BROWSER_VIEWPORT:-1280x720}"
WEB_PORT=6080
LOG_DIR="$HOME/.local/share/browser-vision"
mkdir -p "$LOG_DIR"

# ─── Helper ───────────────────────────────────────────────────────────────────
cleanup_display() {
  # Kill anything on our display
  vncserver -kill ":${DISPLAY_NUM}" 2>/dev/null || true
  pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
  pkill -f "x11vnc.*:${DISPLAY_NUM}" 2>/dev/null || true
  pkill -f "websockify.*${WEB_PORT}" 2>/dev/null || true
  pkill -f "fluxbox.*:${DISPLAY_NUM}" 2>/dev/null || true
  sleep 0.5
}

cleanup_display

# ─── Option A: KasmVNC (preferred) ───────────────────────────────────────────
if command -v vncserver &>/dev/null; then
  echo "Using KasmVNC..."
  mkdir -p "$HOME/.vnc"

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

  if [ $? -eq 0 ]; then
    echo "KasmVNC started on :${DISPLAY_NUM}"
  else
    echo "WARNING: KasmVNC failed:"
    tail -5 "$LOG_DIR/kasmvnc.log" 2>/dev/null
  fi

  # Start window manager
  if command -v fluxbox &>/dev/null; then
    nohup fluxbox -display ":${DISPLAY_NUM}" > "$LOG_DIR/fluxbox.log" 2>&1 &
    disown $!
  fi

  echo "Browser vision web UI: http://localhost:${WEB_PORT}"
  echo "Browser vision server started successfully"
  exit 0
fi

# ─── Option B: Xvfb + x11vnc + websockify fallback ──────────────────────────
echo "KasmVNC not found, using Xvfb + x11vnc fallback..."

# Start Xvfb (virtual X display) — this is needed for Playwright MCP regardless
if command -v Xvfb &>/dev/null; then
  Xvfb ":${DISPLAY_NUM}" -screen 0 "${RESOLUTION}x24" -ac +extension GLX +render -noreset \
    > "$LOG_DIR/xvfb.log" 2>&1 &
  XVFB_PID=$!
  disown $XVFB_PID
  sleep 1

  if kill -0 $XVFB_PID 2>/dev/null; then
    echo "Xvfb started on :${DISPLAY_NUM} (pid $XVFB_PID)"
  else
    echo "ERROR: Xvfb failed to start"
    cat "$LOG_DIR/xvfb.log" 2>/dev/null
    exit 0
  fi
else
  echo "ERROR: Neither KasmVNC nor Xvfb found. Docker image needs rebuilding."
  exit 0
fi

# Start window manager
if command -v fluxbox &>/dev/null; then
  nohup fluxbox -display ":${DISPLAY_NUM}" > "$LOG_DIR/fluxbox.log" 2>&1 &
  disown $!
  echo "fluxbox started"
fi

# Install x11vnc if not present
if ! command -v x11vnc &>/dev/null; then
  echo "Installing x11vnc..."
  sudo apt-get update -qq && sudo apt-get install -y -qq x11vnc > "$LOG_DIR/x11vnc-install.log" 2>&1
  if ! command -v x11vnc &>/dev/null; then
    echo "WARNING: Could not install x11vnc. Xvfb is running for Playwright MCP but no web viewer."
    echo "Browser vision server started successfully"
    exit 0
  fi
  echo "x11vnc installed"
fi

# Start x11vnc
x11vnc -display ":${DISPLAY_NUM}" -nopw -forever -shared -rfbport 5900 \
  > "$LOG_DIR/x11vnc.log" 2>&1 &
X11VNC_PID=$!
disown $X11VNC_PID
sleep 1

if ! kill -0 $X11VNC_PID 2>/dev/null; then
  echo "WARNING: x11vnc failed. Xvfb running for Playwright MCP but no web viewer."
  echo "Browser vision server started successfully"
  exit 0
fi
echo "x11vnc started (pid $X11VNC_PID)"

# Install websockify + noVNC if not present
if ! command -v websockify &>/dev/null; then
  echo "Installing websockify via pip..."
  pip3 install --user --quiet websockify 2>"$LOG_DIR/websockify-install.log" || true
  export PATH="$HOME/.local/bin:$PATH"
fi

# Get noVNC web client
NOVNC_DIR="$HOME/.local/share/noVNC"
if [ ! -d "$NOVNC_DIR" ]; then
  echo "Downloading noVNC..."
  mkdir -p "$NOVNC_DIR"
  curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz \
    | tar xz --strip-components=1 -C "$NOVNC_DIR" 2>"$LOG_DIR/novnc-download.log"
fi

# Ensure vnc.html exists (some versions use vnc_lite.html)
if [ ! -f "$NOVNC_DIR/vnc.html" ] && [ -f "$NOVNC_DIR/vnc_lite.html" ]; then
  ln -sf "$NOVNC_DIR/vnc_lite.html" "$NOVNC_DIR/vnc.html"
fi

# Start websockify with noVNC web serving
if command -v websockify &>/dev/null && [ -d "$NOVNC_DIR" ]; then
  websockify --web="$NOVNC_DIR" ${WEB_PORT} localhost:5900 \
    > "$LOG_DIR/websockify.log" 2>&1 &
  WS_PID=$!
  disown $WS_PID
  sleep 1

  if kill -0 $WS_PID 2>/dev/null; then
    echo "websockify + noVNC started on port ${WEB_PORT} (pid $WS_PID)"
  else
    echo "WARNING: websockify failed. Check $LOG_DIR/websockify.log"
    cat "$LOG_DIR/websockify.log" 2>/dev/null | tail -5
  fi
else
  echo "WARNING: websockify or noVNC not available. No web viewer."
fi

echo ""
echo "Browser vision web UI: http://localhost:${WEB_PORT}/vnc.html?autoconnect=true&resize=remote"
echo "Display: ${DISPLAY}"
echo "Logs: ${LOG_DIR}/"
echo "Browser vision server started successfully"
