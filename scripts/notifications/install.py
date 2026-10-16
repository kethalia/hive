import fcntl
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile

bundle = json.load(sys.stdin)
home = Path.home()
root = home / ".local/share/hive/notifications"
root.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(root, 0o700)


def atomic_write(path, text):
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


# Serialize remote writes and reject stale generations. A late SSH process must
# never restore a credential that a newer, confirmed rotation already revoked.
lock = (root / "install.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX)
try:
    current_path = root / "config.json"
    current = json.loads(current_path.read_text()) if current_path.exists() else {}
    if current.get("url") == bundle["url"]:
        incoming = (bundle.get("createdAt", ""), bundle.get("generation", 0))
        installed = (current.get("createdAt", ""), current.get("generation", 0))
        if incoming < installed:
            print("A newer Hive notification setup is already installed.")
            raise SystemExit(0)

    # Parse both configurations before making changes. Preserve all unrelated hooks.
    codex_path = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "hooks.json"
    claude_path = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude"))) / "settings.json"
    configs = []
    for agent, path in (("codex", codex_path), ("claude", claude_path)):
        config = json.loads(path.read_text()) if path.exists() else {}
        hooks = config.setdefault("hooks", {})
        command = "python3 " + shlex.quote(str(root / "agent-hook.py")) + " " + agent
        groups = {
            "PreToolUse": "^(AskUserQuestion|ExitPlanMode|request_user_input|request_user_input_async)$",
            "PermissionRequest": None, "Stop": None,
        }
        if agent == "claude":
            groups["Notification"] = "^(elicitation_dialog|agent_needs_input)$"
            groups["StopFailure"] = None
        for event, matcher in groups.items():
            entries = hooks.setdefault(event, [])
            # Reinstall without accumulating duplicate Hive hooks.
            for entry in entries:
                entry["hooks"] = [h for h in entry.get("hooks", []) if h.get("command") != command]
            entries[:] = [entry for entry in entries if entry.get("hooks")]
            group = {"hooks": [{"type": "command", "command": command, "timeout": 8, "async": True}]}
            if matcher:
                group["matcher"] = matcher
            entries.append(group)
        configs.append((path, json.dumps(config, indent=2) + "\n"))

    atomic_write(root / "agent-hook.py", bundle["hook"])
    for path, text in configs:
        atomic_write(path, text)
    atomic_write(root / "config.json", json.dumps({key: bundle[key] for key in ("url", "token", "sourceId", "generation", "createdAt") if key in bundle}))
    print("Hive notifications installed. Restart agents; review Codex /hooks.")

finally:
    lock.close()
