#!/usr/bin/env python3
"""Fixed private tmux PTY adapter. No shell or client-selected command/path."""
import codecs
import ctypes
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import pty
import pwd
import re
import selectors
import signal
import struct
import subprocess
import sys
import termios


def require(value):
    if not value:
        raise ValueError("terminal_unavailable")


def private(path, directory=False):
    require(path.is_absolute() and path.resolve() == path)
    st = path.stat()
    require(st.st_uid == os.getuid() and not st.st_mode & 0o077 and (path.is_dir() if directory else path.is_file()))


def signed(directory, name, key_name, envelope):
    private(directory, True)
    path, key_path = directory / name, directory / key_name
    private(path)
    private(key_path)
    require(path.stat().st_size <= 4 * 1024 * 1024)
    key = key_path.read_bytes()
    require(len(key) == 32)
    saved = json.loads(path.read_bytes())
    value = saved[envelope]
    # JS JSON.stringify preserves insertion order, omits insignificant whitespace,
    # and emits Unicode literally. These journals are written only by installed JS.
    encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
    require(hmac.compare_digest(hmac.new(key, encoded, hashlib.sha256).hexdigest(), saved["signature"]))
    return value


def resolve_project(project_id):
    require(re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", project_id))
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    state_dir = home / ".local/state/hive/codex-project-supervisor"
    state = signed(state_dir, "registry.json", "key", "state")
    controller = signed(home / ".local/state/hive/codex-project-controller", "projects.json", "projects.key", "state")
    entry = state["projects"][project_id]
    task = controller["projects"][project_id]["task"]
    prepared = task["prepared"]
    require(state["status"] == "ready" and entry["phase"] == "persisted" and entry["attached"] is True
            and entry["serverInstanceId"] == state["serverInstanceId"]
            and state["ownerId"] == controller["ownerId"] and state["workspaceId"] == controller["workspaceId"]
            and entry["repositoryId"] == prepared["repositoryId"] and task["nativeThreadId"] == entry["threadId"])
    helper = Path(__file__).with_name("managed-projects.py")
    spec = importlib.util.spec_from_file_location("hive_managed_terminal", helper)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    checkout = module.ManagedProjects(home).inspect(prepared["repositoryId"])
    import time
    require(checkout["checkoutVerified"] is True and checkout["lease"]["expiresAt"] > time.time()
            and checkout["lease"]["id"] == prepared["leaseId"] and checkout["lease"]["generation"] == prepared["leaseGeneration"]
            and checkout["lease"]["taskId"] == prepared["taskId"])
    socket = state_dir / "tmux.sock"
    require(socket.resolve() == socket and socket.is_socket() and socket.stat().st_uid == os.getuid()
            and not socket.stat().st_mode & 0o077)
    name = "project-" + hashlib.sha256(project_id.encode()).hexdigest()[:24]
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "TERM": "xterm-256color", "LANG": "C.UTF-8"}
    subprocess.run(["/usr/bin/tmux", "-S", str(socket), "has-session", "-t", "=" + name], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2, check=True)
    return ["/usr/bin/tmux", "-S", str(socket), "attach-session", "-t", "=" + name], env


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    require(len(sys.argv) == 2)
    command, env = resolve_project(sys.argv[1])
    parent_pid = os.getpid()
    pid, master = pty.fork()
    if pid == 0:
        # Native parent-death signal prevents orphan attach clients on bridge crash.
        libc = ctypes.CDLL(None)
        if libc.prctl(1, signal.SIGHUP) != 0 or os.getppid() != parent_pid:
            os._exit(1)
        os.execve(command[0], command, env)
    def stop(*_):
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ)
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    pending = b""
    emit({"type": "ready"})
    try:
        while True:
            for key, _ in selector.select():
                if key.fd == master:
                    try:
                        chunk = os.read(master, 8192)
                    except OSError:
                        chunk = b""
                    if not chunk:
                        _, status = os.waitpid(pid, 0)
                        emit({"type": "exit", "code": os.waitstatus_to_exitcode(status)})
                        return
                    text = decoder.decode(chunk)
                    if text:
                        emit({"type": "output", "text": text})
                else:
                    chunk = os.read(sys.stdin.fileno(), 8192)
                    if not chunk:
                        return
                    pending += chunk
                    require(len(pending) <= 65536)
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        value = json.loads(line)
                        if value.get("type") == "input":
                            require(set(value) == {"type", "text"} and isinstance(value["text"], str))
                            data = value["text"].encode()
                            require(len(data) <= 32768)
                            while data:
                                data = data[os.write(master, data):]
                        else:
                            require(set(value) == {"type", "cols", "rows"} and value["type"] == "resize"
                                    and type(value["cols"]) is int and type(value["rows"]) is int
                                    and 2 <= value["cols"] <= 500 and 2 <= value["rows"] <= 500)
                            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", value["rows"], value["cols"], 0, 0))
    finally:
        selector.close()
        os.close(master)
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"type": "exit", "code": 1})
        raise SystemExit(1) from None
