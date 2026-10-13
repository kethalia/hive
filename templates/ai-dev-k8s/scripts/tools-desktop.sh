#!/bin/bash
set -euo pipefail

# Coder owns authentication/TLS. The backend exposes only its local WebSocket
# endpoint; KasmVNC's independently created wildcard UDP listener is denied.
library=/usr/local/lib/hive/kasmvnc-loopback.so
state_dir="$HOME/.local/state/hive-desktop"
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
exec 9>"$state_dir/start.lock"
flock -x 9

# Retire only owned Xvnc processes on the reserved display or Coder app port.
# Never send signals based solely on a PID file from the persistent home.
python3 - "$state_dir/server.pid" <<'PYTHON'
import os
from pathlib import Path
import signal
import sys
import time

def identity(proc):
    try:
        args = (proc / "cmdline").read_bytes().split(b"\0")
        owned = proc.stat().st_uid == os.getuid()
        port = b"-websocketPort" in args and args[args.index(b"-websocketPort") + 1] == b"6080"
        managed = owned and Path(os.fsdecode(args[0])).name == "Xvnc" and (args[1] == b":1" or port)
        started = (proc / "stat").read_text().rsplit(")", 1)[1].split()[19]
        return started if managed else None
    except (OSError, IndexError):
        return None

for proc in Path("/proc").iterdir():
    if not proc.name.isdigit():
        continue
    started = identity(proc)
    if started is None:
        continue
    try:
        os.kill(int(proc.name), signal.SIGTERM)
        for _ in range(40):
            if identity(proc) != started:
                break
            time.sleep(0.05)
        else:
            if identity(proc) == started:
                os.kill(int(proc.name), signal.SIGKILL)
    except ProcessLookupError:
        pass
Path(sys.argv[1]).unlink(missing_ok=True)
for record in (Path.home() / ".vnc").glob("*:1.pid"):
    record.unlink(missing_ok=True)
PYTHON

if [ ! -r "$library" ] || [ ! -x /usr/bin/Xvnc ] || ! command -v kasmvncserver >/dev/null 2>&1 || ! command -v startxfce4 >/dev/null 2>&1; then
  printf '[error] Desktop image is missing the loopback guard, Xvnc, or XFCE; update the image.\n' >&2
  exit 1
fi

# The dynamic loader can ignore an invalid LD_PRELOAD library. Prove that the
# guard works before starting an unauthenticated backend; no fallback is allowed.
env -u LD_LIBRARY_PATH LD_PRELOAD="$library" python3 - <<'PY'
import errno
import socket
for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
    with socket.socket(socket.AF_INET, kind) as sock:
        try:
            sock.bind(("0.0.0.0", 0))
        except OSError as error:
            if error.errno != errno.EACCES:
                raise
        else:
            raise SystemExit("Desktop loopback guard is not active")
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
PY

umask 077
# Kasm's config loader requires an internal user even with BasicAuth disabled.
# Preserve existing users; create a random unused credential only for a fresh home.
if [ ! -s "$HOME/.kasmpasswd" ]; then
  desktop_password="$(openssl rand -hex 32)"
  printf '%s\n%s\n' "$desktop_password" "$desktop_password" | \
    kasmvncpasswd -wo -u "$(id -un)" >/dev/null 2>&1
  unset desktop_password
fi
# Let the installed config loader preserve desktop/encoding/clipboard settings.
# Explicit CLI options override persisted network settings. Its dry-run prints
# an argv plus log redirection; parse it as data, never evaluate shell output.
command="$(env -u LD_PRELOAD -u LD_LIBRARY_PATH kasmvncserver :1 \
  -dry-run -prompt 0 -select-de xfce -disableBasicAuth -SecurityTypes None \
  -interface 127.0.0.1 -localhost -UseIPv4 1 -UseIPv6 0 \
  -websocketPort 6080 -rfbport -1 -nolisten tcp -sslOnly 0 -PublicIP 127.0.0.1)"
printf '%s\n' "$command" | python3 -c '
import json, shlex, sys
args = shlex.split(sys.stdin.read())
if args[:2] != ["/usr/bin/Xvnc", ":1"] or args[-3] != ">>" or args[-1] != "2>&1":
    raise SystemExit("Unexpected KasmVNC launch command; desktop was not started")
json.dump(args[:-3], sys.stdout)
' >"$state_dir/server-argv.json"
nohup env -u LD_PRELOAD -u LD_LIBRARY_PATH python3 -c '
import json, os, sys
args = json.load(open(sys.argv[2]))
os.environ["LD_PRELOAD"] = sys.argv[1]
os.execv(args[0], args)
' "$library" "$state_dir/server-argv.json" \
  >"$state_dir/server.log" 2>&1 9>&- &
server_pid=$!
ready=false
for _ in {1..40}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  if curl --noproxy '*' --connect-timeout 1 --max-time 1 -fsS http://127.0.0.1:6080/ >/dev/null 2>&1 && python3 - "$server_pid" <<'PY'
from pathlib import Path
import sys
proc = Path(f"/proc/{int(sys.argv[1])}")
try:
    inodes = {p.readlink().name[8:-1] for p in (proc / "fd").iterdir() if str(p.readlink()).startswith("socket:[")}
    listeners = []
    for protocol in ("tcp", "tcp6", "udp", "udp6"):
        for line in (Path("/proc/net") / protocol).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[9] in inodes and (protocol.startswith("udp") or fields[3] == "0A"):
                listeners.append((protocol, fields[1]))
    if listeners != [("tcp", "0100007F:17C0")]:
        raise SystemExit(1)
except OSError:
    raise SystemExit(1)
PY
  then
    ready=true
    break
  fi
  sleep 0.25
done
if [ "$ready" != true ]; then
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  printf '[error] Loopback desktop did not become ready. See %s/server.log\n' "$state_dir" >&2
  exit 1
fi
printf '%s\n' "$server_pid" >"$state_dir/server.pid"
# The guard must not affect Chrome, game engines, or applications started by XFCE.
desktop_command=(startxfce4)
if [ -f "$HOME/.vnc/xstartup" ]; then
  desktop_command=(bash "$HOME/.vnc/xstartup")
fi
nohup env -u LD_PRELOAD -u LD_LIBRARY_PATH DISPLAY=:1 dbus-run-session -- "${desktop_command[@]}" \
  >"$state_dir/desktop.log" 2>&1 9>&- &
printf '[ok] Desktop ready on loopback port 6080 through the owner-only Coder app.\n'
