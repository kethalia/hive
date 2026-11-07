"""Bounded private PTY adapter for the unmodified, separately pinned Claude CLI.

No OAuth endpoint, token exchange, credential-file parser, shell, or arbitrary
terminal input is implemented here. Only official auth commands are executed.
"""
import ctypes
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time
import urllib.parse
import uuid

LIMIT = 65536
executable = os.environ["HIVE_CLAUDE_EXECUTABLE"]
owner = os.getpid()
child = None
master = None
login_id = None
login_url = None
ready = False
submitted = False
notified = False
output = bytearray()
started = 0


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def child_guard():
    if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != owner:
        os._exit(1)


def stop():
    global child, master, login_id, login_url, ready, submitted, notified, output
    if child is not None:
        if child.poll() is None:
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                child.wait(timeout=1)
        child = None
    if master is not None:
        os.close(master)
        master = None
    login_id = login_url = None
    ready = submitted = notified = False
    output = bytearray()


def terminate(_signal, _frame):
    stop()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)


def command(arguments):
    """Bound the full body and wait for the exact process, including failures."""
    proc = subprocess.Popen([executable, "auth", *arguments], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            start_new_session=True, preexec_fn=child_guard, pass_fds=(3,))
    data = bytearray()
    deadline = time.monotonic() + 5
    try:
        while True:
            if time.monotonic() >= deadline: raise ValueError()
            if select.select([proc.stdout], [], [], min(0.1, deadline - time.monotonic()))[0]:
                chunk = os.read(proc.stdout.fileno(), 4096)
                if not chunk: break
                data.extend(chunk)
                if len(data) > LIMIT: raise ValueError()
        code = proc.wait(timeout=max(0.01, deadline - time.monotonic()))
        return code, bytes(data)
    finally:
        if proc.poll() is None:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            proc.wait(timeout=1)
        proc.stdout.close()


def valid_url(value):
    try:
        u = urllib.parse.urlsplit(value)
        return (len(value) <= 8192 and u.scheme == "https" and u.netloc == "claude.com"
                and u.path == "/cai/oauth/authorize" and not u.username and not u.password
                and not u.fragment and bool(u.query))
    except ValueError:
        return False


def pump():
    global login_url, ready, notified
    if child is None: return
    if time.monotonic() - started >= 600: raise ValueError()
    if master is not None and select.select([master], [], [], 0)[0]:
        try: chunk = os.read(master, 4096)
        except OSError: chunk = b""
        output.extend(chunk)
        if len(output) > LIMIT: raise ValueError()
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode("utf-8", errors="replace"))
        if login_url is None:
            links = [url for url in re.findall(r"https://[^\s\x1b]+", text) if valid_url(url)]
            if len(set(links)) == 1: login_url = links[0]
        ready = ready or (login_url is not None and "Paste code here" in text)
    if child.poll() is not None and not notified:
        notified = True
        emit({"method": "account/login/completed", "params": {
            "loginId": login_id, "success": child.returncode == 0}})


def handle(method, params):
    global child, master, login_id, login_url, ready, submitted, notified, output, started
    if method == "initialize": return {"protocol": "hive-claude-cli-auth-v1"}
    if method == "account/read":
        pump()
        # A live CLI owns its pending write. Never run a competing refresh while
        # it is waiting for user input or exchanging the submitted code.
        if child is not None and child.poll() is None: return {"account": None}
        code, data = command(["status", "--json"])
        result = json.loads(data)
        if not isinstance(result, dict) or type(result.get("loggedIn")) is not bool or code not in (0, 1):
            raise ValueError()
        if result["loggedIn"] and code != 0: raise ValueError()
        return {"account": {"type": "claude"} if result["loggedIn"] else None}
    if method == "account/login/start":
        if child is not None: raise ValueError()
        master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        login_id = str(uuid.uuid4())
        child = subprocess.Popen([executable, "auth", "login"], stdin=slave, stdout=slave,
                                 stderr=slave, start_new_session=True, preexec_fn=child_guard,
                                 pass_fds=(3,))
        os.close(slave)
        started = time.monotonic()
        deadline = started + 6
        while not ready and child.poll() is None and time.monotonic() < deadline:
            select.select([master], [], [], 0.05)
            pump()
        if not ready: raise ValueError()
        return {"type": "claudeCli", "loginId": login_id, "verificationUrl": login_url}
    if method == "account/login/submitCode":
        value = params.get("code")
        if (not child or child.poll() is not None or params.get("loginId") != login_id
                or not ready or submitted or not isinstance(value, str) or not 1 <= len(value) <= 2048
                or any(ord(c) < 33 or ord(c) > 126 for c in value)):
            raise ValueError()
        submitted = True  # Durable for this exact process before its only write.
        line = value.encode("ascii") + b"\n"
        if os.write(master, line) != len(line): raise ValueError()
        return {"accepted": True}
    if method == "account/login/cancel":
        if params.get("loginId") != login_id: return {"status": "notFound"}
        stop()
        return {"status": "canceled"}
    if method == "account/logout":
        stop()
        code, _ = command(["logout"])
        if code != 0: raise ValueError()
        return {}
    raise ValueError()


def main():
    buffer = bytearray()
    try:
        while True:
            pump()
            if not select.select([sys.stdin.buffer], [], [], 0.05)[0]: continue
            data = os.read(sys.stdin.fileno(), 4096)
            if not data: break
            buffer.extend(data)
            if len(buffer) > 16384: raise ValueError()
            while b"\n" in buffer:
                raw, _, buffer = buffer.partition(b"\n")
                request = json.loads(raw)
                if not isinstance(request, dict) or type(request.get("id")) is not int: raise ValueError()
                try:
                    result = handle(request.get("method"), request.get("params") or {})
                    emit({"id": request["id"], "result": result})
                except Exception:
                    emit({"id": request["id"], "error": {"code": "claude_account_unavailable"}})
    finally:
        stop()


if __name__ == "__main__":
    try: main()
    except Exception: raise SystemExit(1) from None
