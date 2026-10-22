#!/usr/bin/env python3
"""Workspace-local agent inventory and session recovery. Never export conversation content."""
import concurrent.futures
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
import uuid

LIMIT = 1024 * 1024
AGENTS = ("codex", "claude")
EVENTS = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
          "PermissionRequest", "Stop", "SessionEnd")
CODER_TOOLS = (
    "coder_get_authenticated_user", "coder_list_workspaces", "coder_get_workspace",
    "coder_list_templates", "coder_get_template", "coder_template_version_parameters",
    "coder_get_workspace_agent_logs", "coder_get_workspace_build_logs",
    "coder_get_template_version_logs", "coder_workspace_list_apps",
)


def root():
    return Path.home() / ".local/share/hive/agents"


def config_dir(agent):
    key = "CODEX_HOME" if agent == "codex" else "CLAUDE_CONFIG_DIR"
    return Path(os.environ.get(key, str(Path.home() / ("." + agent))))


def claude_user_config():
    custom = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(custom) if custom else Path.home()) / ".claude.json"


def read_json(path, default=None):
    try:
        with path.open() as handle:
            text = handle.read(LIMIT + 1)
        if len(text) > LIMIT:
            raise ValueError("Configuration is too large")
        return json.loads(text)
    except FileNotFoundError:
        return {} if default is None else default


def atomic_write(path, content):
    # Honor user-owned config symlinks; replace the target, never the link.
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def locked(path=None):
    path = path or root() / "lock"
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        raise ValueError("Agent storage must be a private directory")
    directory.chmod(0o700)
    with path.open("a") as lock:
        deadline = time.monotonic() + 3
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise ValueError("Agent setup is busy; try again")
                time.sleep(0.05)
        yield


def run(args, timeout=5, cwd=None):
    """Bound time and memory, and never let diagnostics escape this process."""
    with tempfile.TemporaryFile() as output:
        try:
            process = subprocess.Popen(args, cwd=cwd or Path.home(), stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True)
        except OSError:
            return 127, ""
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            return 124, ""
        output.seek(0)
        data = output.read(LIMIT + 1)
        if len(data) > LIMIT:
            return 125, ""
        return process.returncode, data.decode("utf-8", "replace")


def text(value, limit=160):
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def hook_command(agent):
    return "python3 " + shlex.quote(str(root() / "agent-tools.py")) + " hook " + agent


def hook_configs():
    return {"codex": config_dir("codex") / "hooks.json",
            "claude": config_dir("claude") / "settings.json"}


def hook_config_lock():
    # Share the existing notification installer lock, including deployed versions.
    # Acquire this before the agent lock so notification setup does not hold up
    # session metadata writes while a tracking configuration change waits.
    return locked(Path.home() / ".local/share/hive/notifications/install.lock")


def install(source):
    with hook_config_lock(), locked():
        updates = []
        # Validate both files before writing anything; merge only our exact hooks.
        for agent, path in hook_configs().items():
            config = read_json(path)
            hooks = config.setdefault("hooks", {})
            events = EVENTS + (("Interrupt",) if agent == "codex" else ("StopFailure", "Notification"))
            for event in events:
                entries = hooks.setdefault(event, [])
                command = hook_command(agent)
                for entry in entries:
                    entry["hooks"] = [h for h in entry.get("hooks", []) if h.get("command") != command]
                entries[:] = [entry for entry in entries if entry.get("hooks")]
                # Synchronous, local metadata writes preserve event order. Never block a decision.
                entries.append({"hooks": [{"type": "command", "command": command, "timeout": 4}]})
            updates.append((path, json.dumps(config, indent=2) + "\n"))
        atomic_write(root() / "agent-tools.py", source)
        for path, content in updates:
            atomic_write(path, content)
    return {"message": "Session tracking installed. Restart agents; review Codex /hooks."}


def disable_tracking():
    with hook_config_lock(), locked():
        updates = []
        for agent, path in hook_configs().items():
            config = read_json(path)
            for entries in config.get("hooks", {}).values():
                for entry in entries:
                    entry["hooks"] = [h for h in entry.get("hooks", []) if h.get("command") != hook_command(agent)]
                entries[:] = [entry for entry in entries if entry.get("hooks")]
            updates.append((path, json.dumps(config, indent=2) + "\n"))
        for path, content in updates:
            atomic_write(path, content)
    return {"message": "Tracking hooks removed. Restart agents. Recorded sessions remain available."}


def session_key(agent, session_id):
    if agent not in AGENTS or str(uuid.UUID(session_id)) != session_id.lower():
        raise ValueError("Invalid agent session")
    return agent + "-" + session_id.lower()


def process_identity(pid):
    try:
        stat = Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return f"{boot}:{stat[19]}"
    except (OSError, ValueError, TypeError, IndexError):
        return None


def agent_process(agent):
    pid = os.getppid()
    for _ in range(12):
        try:
            command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
            if any(Path(arg.decode("utf-8", "replace")).name in (agent, agent + ".js")
                   for arg in command[:2]):
                return pid, process_identity(pid)
            pid = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
            if pid <= 1:
                break
        except (OSError, ValueError, IndexError):
            break
    return None, None


def state_for(event):
    name = event.get("hook_event_name")
    if name == "PreToolUse" and event.get("tool_name", "").split(".")[-1] in (
        "AskUserQuestion", "ExitPlanMode", "request_user_input", "request_user_input_async"
    ):
        return "needs-input"
    if name == "Notification":
        kind = event.get("notification_type")
        return {"permission_prompt": "needs-approval", "elicitation_dialog": "needs-input",
                "agent_needs_input": "needs-input"}.get(kind)
    return {"SessionStart": "ready", "UserPromptSubmit": "working", "PreToolUse": "working",
            "PostToolUse": "working", "PermissionRequest": "needs-approval", "Stop": "ready",
            "Interrupt": "interrupted", "SessionEnd": "ended", "StopFailure": "failed"}.get(name)


def track(agent, event):
    state = state_for(event)
    if not state:
        return
    session_id = event.get("session_id", "")
    key = session_key(agent, session_id)
    cwd = Path(event.get("cwd") or os.getcwd()).resolve()
    if not cwd.is_relative_to(Path.home().resolve()) or not cwd.is_dir():
        return
    pid, identity = agent_process(agent)
    pane = os.environ.get("TMUX_PANE", "")
    if not re.fullmatch(r"%[0-9]+", pane):
        pane = ""
    # Only record Hive's tmux socket; default-socket terminals stay native.
    socket = os.environ.get("TMUX", "").split(",")[0]
    if Path(socket).name != "web":
        pane = ""
    with locked():
        path = root() / "sessions.json"
        sessions = read_json(path)
        previous = sessions.get(key, {})
        sessions[key] = {
            "agent": agent, "id": session_id.lower(), "cwd": str(cwd), "project": cwd.name,
            "updatedAt": int(time.time()), "state": state, "pane": pane,
            "pid": pid or previous.get("pid"), "processIdentity": identity or previous.get("processIdentity"),
        }
        sessions = dict(sorted(sessions.items(), key=lambda item: item[1]["updatedAt"], reverse=True)[:200])
        atomic_write(path, json.dumps(sessions) + "\n")


def alive(record):
    return bool(record.get("state") != "ended" and record.get("processIdentity") and
                process_identity(record.get("pid")) == record["processIdentity"])


def public_sessions():
    try:
        records = read_json(root() / "sessions.json")
        result = []
        for key, record in records.items():
            if key != session_key(record["agent"], record["id"]):
                continue
            directory = Path(record["cwd"])
            if not directory.is_absolute() or not directory.is_relative_to(Path.home()):
                continue
            running = alive(record)
            state = record["state"]
            if not running and state not in ("ended", "failed"):
                state = "offline"
            result.append({"key": key, "agent": record["agent"], "id": record["id"],
                           "directory": str(directory.relative_to(Path.home())) or ".",
                           "project": text(record["project"]), "updatedAt": record["updatedAt"],
                           "state": state, "running": running,
                           "directoryExists": directory.is_dir()})
        return sorted(result, key=lambda item: item["updatedAt"], reverse=True)[:200]
    except (OSError, ValueError, TypeError, KeyError):
        return []


def inventory(agent):
    code, version_output = run([agent, "--version"])
    version = re.search(r"\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b", version_output)
    result = {"agent": agent, "installed": code == 0, "version": version.group(0) if version else None,
              "auth": "unknown", "tracking": False, "connections": [], "plugins": [], "warnings": []}
    try:
        hooks = read_json(hook_configs()[agent]).get("hooks", {})
        result["tracking"] = all(any(h.get("command") == hook_command(agent)
            for group in hooks.get(event, []) for h in group.get("hooks", [])) for event in EVENTS)
    except (OSError, ValueError, TypeError, AttributeError):
        result["warnings"].append("Agent hook configuration could not be read.")
    if not result["installed"]:
        return result
    if agent == "codex":
        auth_code, auth = run(["codex", "login", "status"])
        result["auth"] = "signed-in" if auth_code == 0 else ("signed-out" if "not logged in" in auth.lower() else "unknown")
        code, output = run(["codex", "mcp", "list", "--json"])
        try:
            if code != 0:
                raise ValueError()
            for entry in json.loads(output)[:200]:
                result["connections"].append({"name": text(entry["name"]), "enabled": entry.get("enabled", True),
                    "auth": text(entry.get("auth_status", "unknown"))})
        except (ValueError, KeyError, TypeError, AttributeError):
            result["warnings"].append("MCP inventory unavailable; check /mcp in Codex.")
        code, output = run(["codex", "plugin", "list", "--json"])
    else:
        code, output = run(["claude", "auth", "status", "--json"])
        try:
            auth = json.loads(output)
            result["auth"] = "signed-in" if auth.get("loggedIn") is True else ("signed-out" if auth.get("loggedIn") is False else "unknown")
        except (ValueError, TypeError, AttributeError):
            pass
        # Include the home-level files seeded by init.sh even with a custom config
        # directory. Project overrides and plugin tools remain visible in /mcp.
        paths = dict.fromkeys((claude_user_config(), config_dir("claude") / "mcp.json",
                              Path.home() / ".claude/mcp.json", Path.home() / ".mcp.json"))
        names = set()
        unreadable = False
        for path in paths:
            try:
                servers = read_json(path).get("mcpServers", {})
                if not isinstance(servers, dict):
                    raise ValueError("Invalid MCP configuration")
                names.update(text(name) for name in servers if text(name))
            except (OSError, ValueError, TypeError, AttributeError):
                unreadable = True
        result["connections"] = [{"name": name, "enabled": True, "auth": "unknown"}
                                 for name in sorted(names)[:200]]
        if unreadable:
            result["warnings"].append("Some Claude MCP configuration could not be read.")
        code, output = run(["claude", "plugin", "list", "--json"])
    try:
        if code != 0:
            raise ValueError()
        plugins = json.loads(output)
        if isinstance(plugins, dict):
            plugins = plugins.get("plugins", plugins.get("installed", []))
        for plugin in plugins[:100]:
            if isinstance(plugin, dict):
                name = text(plugin.get("pluginId") or plugin.get("id") or plugin.get("name"))
                if name:
                    result["plugins"].append({"name": name, "enabled": plugin.get("enabled") is not False})
    except (ValueError, TypeError, AttributeError):
        result["warnings"].append("Plugin inventory unavailable; use the agent's plugin browser.")
    return result


def inspect():
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        agents = list(pool.map(inventory, AGENTS))
    profile = os.environ.get("HIVE_WORKSPACE_PROFILE", "unknown")
    _, help_text = run(["coder", "exp", "mcp", "server", "--help"], timeout=3)
    return {"profile": text(profile), "agents": agents, "sessions": public_sessions(),
            "coderMcpSupported": profile == "software" and "--allowed-tools" in help_text,
            "typescriptServerInstalled": bool(shutil.which("typescript-language-server")),
            "checkedAt": int(time.time())}


def configure_coder():
    if os.environ.get("HIVE_WORKSPACE_PROFILE") != "software":
        raise ValueError("Coder orchestration belongs in the software workspace")
    code, output = run(["coder", "exp", "mcp", "server", "--help"])
    if code or "--allowed-tools" not in output:
        raise ValueError("This Coder version does not support the MCP tool allowlist")
    with locked():
        codex_path = config_dir("codex") / "config.toml"
        existing = codex_path.read_text() if codex_path.exists() else ""
        codex = tomllib.loads(existing)
        claude_path = claude_user_config()
        claude = read_json(claude_path)
        servers = claude.setdefault("mcpServers", {})
        if not isinstance(servers, dict) or not isinstance(codex.get("mcp_servers", {}), dict):
            raise ValueError("Invalid MCP configuration")
        args = ["exp", "mcp", "server", "--allowed-tools", ",".join(CODER_TOOLS)]
        # Existing entries, including disabled settings, belong to the user.
        if "hive_coder" not in codex.get("mcp_servers", {}):
            updated = existing.rstrip() + '\n\n[mcp_servers.hive_coder]\ncommand = "coder"\nargs = ' + json.dumps(args) + '\n'
            tomllib.loads(updated)
            atomic_write(codex_path, updated)
        if "hive_coder" not in servers:
            servers["hive_coder"] = {"type": "stdio", "command": "coder", "args": args}
            atomic_write(claude_path, json.dumps(claude, indent=2) + "\n")
    return {"message": "Coder inspection tools configured. Restart agents and check /mcp."}


def resume(key):
    with locked():
        record = read_json(root() / "sessions.json").get(key)
        if not record or session_key(record["agent"], record["id"]) != key:
            raise ValueError("This agent session is no longer recorded")
        if alive(record):
            pane = record.get("pane", "")
            code, name = run(["tmux", "-L", "web", "display-message", "-p", "-t", pane, "#{session_name}"]) if re.fullmatch(r"%[0-9]+", pane) else (1, "")
            name = name.strip()
            if code == 0 and re.fullmatch(r"[a-zA-Z0-9._-]{1,200}", name):
                return {"sessionName": name}
            raise ValueError("This agent is already running. Open its original terminal.")
        cwd = Path(record["cwd"]).resolve()
        if not cwd.is_relative_to(Path.home().resolve()) or not cwd.is_dir():
            raise ValueError("The session directory is unavailable. Restore it before resuming.")
        agent = record["agent"]
        if not shutil.which(agent):
            raise ValueError("Install this agent in the workspace before resuming")
        name = "hive-" + key
        code, _ = run(["tmux", "-L", "web", "has-session", "-t", "=" + name])
        if code == 0:
            return {"sessionName": name}
        command = [agent, "resume" if agent == "codex" else "--resume", record["id"]]
        environment = []
        if shutil.which("hive-audio"):
            code, pulse = run(["hive-audio", "prepare", "--", name], timeout=5)
            if code == 0 and pulse.strip().startswith("unix:") and "\n" not in pulse.strip():
                environment = ["-e", "PULSE_SERVER=" + pulse.strip()]
        code, _ = run(["tmux", "-L", "web", "new-session", "-d", "-s", name,
                       "-c", str(cwd), *environment, *command])
        if code:
            raise ValueError("Could not open the recovery terminal; refresh and try again")
        return {"sessionName": name}


def main():
    os.umask(0o077)
    os.environ["PATH"] = str(Path.home() / ".local/bin") + ":" + os.environ.get("PATH", "")
    if len(sys.argv) > 1 and sys.argv[1] == "hook":
        # Hook failures never affect the agent's decisions or reveal hook input.
        try:
            track(sys.argv[2], json.loads(sys.stdin.read(LIMIT + 1)))
        except Exception:
            pass
        return
    request = json.loads(sys.stdin.read(LIMIT + 1))
    operation = request.get("operation")
    try:
        if operation == "inspect":
            result = inspect()
        elif operation == "install":
            result = install(request["source"])
        elif operation == "configure-coder":
            result = configure_coder()
        elif operation == "disable":
            result = disable_tracking()
        elif operation == "resume":
            result = resume(request["key"])
        else:
            raise ValueError("Unknown agent operation")
        print(json.dumps({"ok": True, "data": result}))
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        # Do not echo exceptions: config parser errors can include credentials.
        print(json.dumps({"ok": False, "error": "Agent operation failed. Check the workspace configuration and try again."}))


if __name__ == "__main__":
    main()
