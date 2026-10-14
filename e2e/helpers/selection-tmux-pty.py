"""Isolated real tmux PTY for the browser selection fixture (no user config)."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

socket = sys.argv[1]
pid, master = pty.fork()
if pid == 0:
    env = dict(os.environ, TERM="xterm-256color")
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    os.execvpe("tmux", [
        "tmux", "-S", socket, "-f", "/dev/null", "-T", "clipboard,RGB",
        "set", "-s", "set-clipboard", "on", ";",
        "new-session", "-s", "selection", "/bin/sh -c 'printf \"\\033[2J\\033[HALPHA beta GAMMA delta\\r\\nsecond line to select\\r\\nhttps://example.com/demo\\r\\n\"; exec cat'", ";",
        "set", "status", "off", ";", "set", "mouse", "on",
    ], env)

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 10, 32, 0, 0))

def stop(_signum, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
try:
    while True:
        for fd in select.select([master, 0], [], [])[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                raise SystemExit(0)
            if not chunk:
                raise SystemExit(0)
            os.write(1 if fd == master else master, chunk)
finally:
    subprocess.run(["tmux", "-S", socket, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    os.close(master)
    os.waitpid(pid, 0)
