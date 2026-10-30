#!/usr/bin/env python3
"""Fixed read-only workspace operations. Only the installed verifier invokes this.

The request cannot choose an executable, command, socket, root, or environment.
Tests inject the socket directory through trusted config, never the wire request.
"""
import base64
import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import time
from pathlib import Path

PROFILES = {"software", "browser", "game", "electronics", "infrastructure"}
FILE_PROFILES = {"software", "game", "electronics"}
MAX_INPUT = 589824
MAX_OUTPUT = 131072
SESSION = re.compile(r"[A-Za-z0-9._-]{1,200}")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class Rejected(Exception):
    pass


def require(value, error="read_unavailable"):
    if not value:
        raise Rejected(error)


def exact(value, required, optional=()):
    return isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional)


def valid_path(value):
    return isinstance(value, str) and 0 < len(value) <= 4096 and not CONTROL.search(value)


def contained(path, root):
    return root == "/" or path == root or path.startswith(root + "/")


def tmux(config, arguments):
    # Fixed basename `web`; never open the private project/native socket.
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C", "HOME": config["home"]}
    if config["socketDirectory"] is not None:
        path = config["socketDirectory"]
        info = os.lstat(path)
        require(os.path.realpath(path) == path and stat.S_ISDIR(info.st_mode)
                and info.st_uid == os.getuid() and not info.st_mode & 0o077)
        env["TMUX_TMPDIR"] = path
    child = subprocess.Popen(["/usr/bin/tmux", "-L", "web", "-f", "/dev/null", *arguments],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env, start_new_session=True)
    selected = selectors.DefaultSelector()
    selected.register(child.stdout, selectors.EVENT_READ, "stdout")
    selected.register(child.stderr, selectors.EVENT_READ, "stderr")
    chunks = {"stdout": bytearray(), "stderr": bytearray()}
    limit = time.monotonic() + 2
    try:
        while selected.get_map():
            require(time.monotonic() < limit, "tmux_timeout")
            for key, _ in selected.select(min(0.1, max(0, limit - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    selected.unregister(key.fileobj)
                    continue
                chunks[key.data].extend(data)
                require(sum(len(v) for v in chunks.values()) <= 262144, "too_many_sessions")
        code = child.wait(timeout=max(0.01, limit - time.monotonic()))
        return code, bytes(chunks["stdout"]), bytes(chunks["stderr"])
    except subprocess.TimeoutExpired:
        raise Rejected("tmux_timeout") from None
    finally:
        selected.close()
        # Only this still-owned child is signalled before wait/reap. Never a
        # recorded numeric PID/process group after it has already been reaped.
        if child.poll() is None:
            child.kill()
        child.wait(timeout=1)
        child.stdout.close()
        child.stderr.close()


def absent(code, out, err):
    value = (err + b"\n" + out).decode("utf-8", "replace").strip()
    return bool(code and (re.fullmatch(r"no server running on /[^\r\n]+", value)
                or (code == 1 and re.fullmatch(r"error connecting to /[^\r\n]+/web \(No such file or directory\)", value))))


def directory(config, name):
    code, out, err = tmux(config, ["has-session", "-t", "=" + name])
    if absent(code, out, err):
        return {"cwd": None, "state": "missing_server"}
    if code:
        diagnostic = (err + b"\n" + out).decode("utf-8", "replace").strip()
        if code == 1 and re.fullmatch(r"can't find session: [A-Za-z0-9._-]{1,200}", diagnostic):
            return {"cwd": None, "state": "missing_session"}
        raise Rejected("tmux_unavailable")
    code, out, err = tmux(config, ["display-message", "-p", "-t", "=" + name + ":", "#{pane_current_path}"])
    if absent(code, out, err):
        return {"cwd": None, "state": "missing_server"}
    if code:
        diagnostic = (err + b"\n" + out).decode("utf-8", "replace").strip()
        if re.fullmatch(r"can't find session: [A-Za-z0-9._-]{1,200}", diagnostic):
            return {"cwd": None, "state": "missing_session"}
        raise Rejected("tmux_unavailable")
    try:
        path = out.decode("utf-8").rstrip("\n")
    except UnicodeDecodeError:
        raise Rejected("directory_unavailable") from None
    require(valid_path(path) and path.startswith("/"), "directory_unavailable")
    return {"cwd": path, "state": "present"}


def sessions(config, request):
    code, out, err = tmux(config, ["list-sessions", "-F", "#{session_name}:#{session_created}:#{session_windows}"])
    if absent(code, out, err):
        rows = []
    else:
        require(code == 0, "tmux_unavailable")
        try:
            lines = out.decode("utf-8").splitlines()
        except UnicodeDecodeError:
            raise Rejected("unsupported_session_name") from None
        require(len(lines) <= 1024, "too_many_sessions")
        rows = []
        for line in lines:
            parts = line.split(":")
            require(len(parts) == 3 and SESSION.fullmatch(parts[0]), "unsupported_session_name")
            require(parts[1].isdigit() and parts[2].isdigit(), "tmux_unavailable")
            created, windows = int(parts[1]), int(parts[2])
            require(0 <= created <= 2**53 - 1 and 0 < windows <= 2**31 - 1, "tmux_unavailable")
            if not parts[0].startswith("git-clone-"):
                rows.append({"name": parts[0], "created": created, "windows": windows})
        rows.sort(key=lambda row: row["name"])
        require(len({row["name"] for row in rows}) == len(rows), "tmux_unavailable")
    snapshot = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    offset = 0
    cursor = request.get("cursor")
    if cursor is not None:
        try:
            require(isinstance(cursor, str) and len(cursor) <= 256 and re.fullmatch(r"[A-Za-z0-9_-]+", cursor), "invalid_cursor")
            parsed = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
            require(exact(parsed, ("snapshot", "offset")) and type(parsed["offset"]) is int
                    and 0 < parsed["offset"] < len(rows) and parsed["offset"] % 64 == 0, "invalid_cursor")
            require(parsed["snapshot"] == snapshot, "stale_cursor")
            offset = parsed["offset"]
        except (ValueError, TypeError, KeyError):
            raise Rejected("invalid_cursor") from None
    page = rows[offset:offset + 64]
    next_cursor = None
    if offset + len(page) < len(rows):
        value = json.dumps({"snapshot": snapshot, "offset": offset + len(page)}, separators=(",", ":")).encode()
        next_cursor = base64.urlsafe_b64encode(value).decode().rstrip("=")
    return {"sessions": page, "nextCursor": next_cursor}


def paths(config, request):
    require(config["profile"] in FILE_PROFILES, "unsupported_profile_operation")
    current = directory(config, request["sessionName"])["cwd"]
    fallback = request.get("fallbackPath")
    root = config["projectsRoot"]
    if current:
        source = "tmux"
    elif fallback is not None:
        require(valid_path(fallback), "directory_unavailable")
        current = os.path.abspath(os.path.join(root, fallback))
        source = "fallback"
    else:
        source = "default"
    result = []
    for index, path in enumerate(request["paths"]):
        state = "invalid_path"
        if valid_path(path):
            expanded = os.path.join(config["home"], path[2:]) if path.startswith("~/") else path
            if not os.path.isabs(expanded) and current is None:
                state = "cwd_unavailable"
            else:
                resolved = os.path.abspath(os.path.join(current or "/", expanded))
                if not contained(resolved, root) or not contained(os.path.realpath(resolved), os.path.realpath(root)):
                    state = "outside_supported_root"
                else:
                    try:
                        info = os.stat(resolved)
                        state = "file" if stat.S_ISREG(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "unavailable"
                    except (FileNotFoundError, NotADirectoryError):
                        state = "missing"
                    except OSError:
                        state = "unavailable"
        result.append({"index": index, "status": state})
    return {"cwd": current, "source": source, "candidates": result}


def execute(config, request):
    require(exact(config, ("profile", "projectsRoot", "home", "socketDirectory")))
    require(config["profile"] in PROFILES)
    for key in ("projectsRoot", "home"):
        require(valid_path(config[key]) and os.path.isabs(config[key])
                and os.path.normpath(config[key]) == config[key])
    require(isinstance(request, dict) and request.get("operation") in ("sessions", "directory", "paths"))
    op = request["operation"]
    require(exact(request, ("operation",), ("cursor",)) if op == "sessions"
            else exact(request, ("operation", "sessionName"), ("fallbackPath", "paths")) if op == "paths"
            else exact(request, ("operation", "sessionName")))
    if op == "sessions" and "cursor" in request:
        require(isinstance(request["cursor"], str) and len(request["cursor"]) <= 256, "invalid_cursor")
    if op != "sessions":
        require(isinstance(request["sessionName"], str) and SESSION.fullmatch(request["sessionName"]))
    if op == "paths":
        require(isinstance(request.get("paths"), list) and len(request["paths"]) <= 128)
        require(all(isinstance(v, str) and 0 < len(v) <= 4096 for v in request["paths"]))
        require("fallbackPath" not in request or valid_path(request["fallbackPath"]))
    return sessions(config, request) if op == "sessions" else directory(config, request["sessionName"]) if op == "directory" else paths(config, request)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        require(len(raw) <= MAX_INPUT, "request_too_large")
        packet = json.loads(raw)
        require(exact(packet, ("config", "request")))
        result = {"ok": True, "data": execute(packet["config"], packet["request"])}
    except Rejected as error:
        result = {"ok": False, "error": str(error)}
    except Exception:
        result = {"ok": False, "error": "read_unavailable"}
    encoded = json.dumps(result, separators=(",", ":")).encode()
    if len(encoded) > MAX_OUTPUT:
        encoded = b'{"ok":false,"error":"read_unavailable"}'
    sys.stdout.buffer.write(encoded + b"\n")


if __name__ == "__main__":
    main()
