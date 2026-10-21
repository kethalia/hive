import concurrent.futures
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

sys.dont_write_bytecode = True

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/agent-tools.py"
SPEC = importlib.util.spec_from_file_location("agent_tools", SOURCE)
tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tools)


class AgentToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.patch = patch.object(Path, "home", return_value=self.home)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.env = patch.dict(os.environ, {"HOME": str(self.home), "HIVE_WORKSPACE_PROFILE": "software",
            "CODEX_HOME": str(self.home / ".codex"), "CLAUDE_CONFIG_DIR": str(self.home / ".claude")})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.cwd = self.home / "projects" / "a repo's $(touch nope)"
        self.cwd.mkdir(parents=True)
        self.id = str(uuid.uuid4())

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def record(self, agent="codex", **extra):
        key = tools.session_key(agent, self.id)
        self.write(tools.root() / "sessions.json", {key: {
            "id": self.id, "agent": agent, "cwd": str(self.cwd), "project": self.cwd.name,
            "updatedAt": 123, "state": "ready", "pid": None, "processIdentity": None,
            "pane": "%1", **extra,
        }})
        return key

    def test_install_is_idempotent_preserves_settings_and_symlinks(self):
        target = self.home / "dotfiles" / "claude.json"
        user_hook = {"hooks": [{"type": "command", "command": "my-hook"}]}
        self.write(target, {"env": {"PRIVATE": "secret"}, "hooks": {"Stop": [user_hook]}})
        path = tools.hook_configs()["claude"]
        path.parent.mkdir(parents=True)
        path.symlink_to(target)
        for _ in range(2):
            tools.install(SOURCE.read_text())
        result = json.loads(target.read_text())
        self.assertTrue(path.is_symlink())
        self.assertEqual(result["env"], {"PRIVATE": "secret"})
        self.assertIn(user_hook, result["hooks"]["Stop"])
        self.assertEqual(len(result["hooks"]["Stop"]), 2)
        self.assertEqual(stat.S_IMODE((tools.root() / "agent-tools.py").stat().st_mode), 0o600)
        tools.disable_tracking()
        self.assertEqual(json.loads(target.read_text())["hooks"]["Stop"], [user_hook])

    def test_malformed_config_does_not_partially_install(self):
        path = tools.hook_configs()["claude"]
        path.parent.mkdir(parents=True)
        path.write_text('invalid "secret"')
        with self.assertRaises(ValueError):
            tools.install(SOURCE.read_text())
        self.assertFalse(tools.hook_configs()["codex"].exists())
        self.assertFalse((tools.root() / "agent-tools.py").exists())

    def test_tracking_mutations_serialize_with_notification_install(self):
        installer = SOURCE.parents[3] / "scripts/notifications/install.py"
        bundle = {"url": "https://hive.test/api/notifications/events", "token": "fixture", "hook": "# fixture"}
        for operation in ("install", "disable"):
            with self.subTest(operation=operation):
                for path in tools.hook_configs().values():
                    self.write(path, {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "user-custom"}]}]}})
                if operation == "disable":
                    tools.install(SOURCE.read_text())
                notification_ready = threading.Event()
                release_notification = threading.Event()
                tracking_progress = threading.Event()
                replace = os.replace
                flock = tools.fcntl.flock

                def pause_notification(source, target):
                    if Path(target).name == "agent-hook.py":
                        notification_ready.set()
                        if not release_notification.wait(5):
                            raise TimeoutError("Notification test synchronization timed out")
                    return replace(source, target)

                def observe_lock(handle, mode):
                    try:
                        return flock(handle, mode)
                    except BlockingIOError:
                        tracking_progress.set()
                        raise

                def change_tracking():
                    try:
                        return tools.install(SOURCE.read_text()) if operation == "install" else tools.disable_tracking()
                    finally:
                        tracking_progress.set()

                with patch.object(os, "replace", side_effect=pause_notification), \
                        patch.object(tools.fcntl, "flock", side_effect=observe_lock), \
                        patch("sys.stdin", io.StringIO(json.dumps(bundle))), \
                        contextlib.redirect_stdout(io.StringIO()), \
                        concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    notification = pool.submit(runpy.run_path, str(installer))
                    try:
                        self.assertTrue(notification_ready.wait(5))
                        tracking = pool.submit(change_tracking)
                        self.assertTrue(tracking_progress.wait(5))
                    finally:
                        release_notification.set()
                    notification.result(timeout=5)
                    tracking.result(timeout=5)

                for agent, path in tools.hook_configs().items():
                    hooks = json.loads(path.read_text())["hooks"]["Stop"]
                    commands = [hook["command"] for group in hooks for hook in group["hooks"]]
                    self.assertIn("user-custom", commands)
                    self.assertTrue(any("agent-hook.py" in command for command in commands))
                    self.assertEqual(tools.hook_command(agent) in commands, operation == "install")

    def test_hook_records_only_metadata_and_reports_offline_after_process_exit(self):
        event = {"session_id": self.id, "cwd": str(self.cwd), "hook_event_name": "PreToolUse",
                 "tool_name": "request_user_input", "tool_input": {"secret": "private prompt"},
                 "transcript_path": "/private", "last_assistant_message": "private answer"}
        with patch.object(tools, "agent_process", return_value=(111, "boot:1")), patch.dict(os.environ, {"TMUX": "/tmp/tmux-1000/web,1,0", "TMUX_PANE": "%2"}):
            tools.track("codex", event)
        raw = (tools.root() / "sessions.json").read_text()
        self.assertNotIn("private", raw)
        with patch.object(tools, "process_identity", return_value="boot:1"):
            row = tools.public_sessions()[0]
            self.assertEqual(row["state"], "needs-input")
            self.assertTrue(row["running"])
            self.assertNotIn("pid", row)
            self.assertFalse(row["directory"].startswith("/"))
        with patch.object(tools, "process_identity", return_value="another-boot:1"):
            self.assertEqual(tools.public_sessions()[0]["state"], "offline")

    def test_sessions_without_pid_do_not_hide_history(self):
        self.record()
        self.assertEqual(len(tools.public_sessions()), 1)
        self.assertFalse(tools.public_sessions()[0]["running"])

    def test_terminal_hook_states_survive_process_exit(self):
        for event_name, state in [("SessionEnd", "ended"), ("StopFailure", "failed")]:
            with self.subTest(event=event_name):
                with patch.object(tools, "agent_process", return_value=(111, "boot:1")):
                    tools.track("claude", {"session_id": self.id, "cwd": str(self.cwd),
                                           "hook_event_name": event_name})
                with patch.object(tools, "process_identity", return_value=None):
                    row = tools.public_sessions()[0]
                self.assertEqual(row["state"], state)
                self.assertFalse(row["running"])

    def test_failed_turn_keeps_live_process_available(self):
        self.record(state="failed", pid=111, processIdentity="boot:1")
        with patch.object(tools, "process_identity", return_value="boot:1"):
            row = tools.public_sessions()[0]
        self.assertEqual(row["state"], "failed")
        self.assertTrue(row["running"])

    def test_resume_uses_fixed_argument_vector_and_recorded_directory(self):
        key = self.record()
        with patch.object(tools.shutil, "which", side_effect=lambda name: "/bin/codex" if name == "codex" else None), \
                patch.object(tools, "run", side_effect=[(1, ""), (0, "")]) as run:
            result = tools.resume(key)
        args = run.call_args.args[0]
        self.assertEqual(args[-3:], ["codex", "resume", self.id])
        self.assertIn(str(self.cwd), args)
        self.assertNotIn("sh", args)
        self.assertEqual(result, {"sessionName": "hive-" + key})

    def test_running_agent_opens_existing_terminal_without_launch(self):
        key = self.record(pid=111, processIdentity="boot:1")
        with patch.object(tools, "process_identity", return_value="boot:1"), \
                patch.object(tools, "run", return_value=(0, "git-clone-abc\n")) as run:
            self.assertEqual(tools.resume(key), {"sessionName": "git-clone-abc"})
        self.assertEqual(run.call_count, 1)
        self.assertNotIn("new-session", run.call_args.args[0])

    def test_running_agent_outside_hive_is_not_duplicated(self):
        key = self.record(pid=111, processIdentity="boot:1", pane="")
        with patch.object(tools, "process_identity", return_value="boot:1"), patch.object(tools, "run") as run:
            with self.assertRaisesRegex(ValueError, "already running"):
                tools.resume(key)
        run.assert_not_called()

    def test_resume_rejects_missing_or_escaped_directory_and_unrecorded_id(self):
        for path in [str(self.home / "missing"), "/tmp"]:
            key = self.record(cwd=path)
            with patch.object(tools, "run") as run:
                with self.assertRaises(ValueError):
                    tools.resume(key)
                run.assert_not_called()
        with self.assertRaises(ValueError):
            tools.resume("codex-" + str(uuid.uuid4()))

    def test_inventory_does_not_return_credentials_or_account_identity(self):
        self.write(tools.claude_user_config(), {"mcpServers": {"vendor": {"url": "https://secret.example", "headers": {"Authorization": "secret-token"}}}})
        outputs = [(0, "2.1.170"), (0, json.dumps({"loggedIn": True, "email": "private@example.com"})),
                   (0, json.dumps([{"id": "typescript-lsp@claude-plugins-official", "enabled": False, "installPath": "/private"}]))]
        with patch.object(tools, "run", side_effect=outputs):
            result = tools.inventory("claude")
        raw = json.dumps(result)
        self.assertNotIn("private", raw)
        self.assertNotIn("secret", raw)
        self.assertEqual(result["auth"], "signed-in")
        self.assertEqual(result["plugins"][0]["enabled"], False)
        self.assertEqual(result["connections"][0]["name"], "vendor")

    def test_codex_inventory_bounds_connections_without_exposing_credentials(self):
        for count in (0, 200, 205):
            with self.subTest(count=count):
                entries = [{"name": f"server-{i}", "enabled": i % 2 == 0, "auth_status": "unsupported",
                            "env": {"TOKEN": "secret"}} for i in range(count)]
                outputs = [(0, "codex-cli 0.163.0"), (0, "Logged in"), (0, json.dumps(entries)), (0, '[]')]
                with patch.object(tools, "run", side_effect=outputs):
                    result = tools.inventory("codex")
                self.assertEqual(result["connections"], [
                    {"name": item["name"], "enabled": item["enabled"], "auth": "unsupported"}
                    for item in entries[:200]
                ])
                self.assertEqual(result["warnings"], [])
                self.assertNotIn("secret", json.dumps(result))

    def test_coder_setup_uses_read_only_allowlist_and_preserves_user_entry(self):
        self.write(tools.claude_user_config(), {"mcpServers": {"hive_coder": {"command": "custom"}}})
        with patch.object(tools, "run", return_value=(0, "--allowed-tools")):
            tools.configure_coder()
            tools.configure_coder()
        config = tools.tomllib.loads((self.home / ".codex/config.toml").read_text())
        args = config["mcp_servers"]["hive_coder"]["args"]
        self.assertIn("--allowed-tools", args)
        self.assertNotIn("coder_workspace_bash", args[-1])
        self.assertNotIn("task", args[-1])
        self.assertNotIn("create", args[-1])
        self.assertEqual(json.loads(tools.claude_user_config().read_text())["mcpServers"]["hive_coder"], {"command": "custom"})

    def test_claude_inventory_combines_managed_and_custom_configs_without_secrets(self):
        custom = self.home / "custom-claude"
        definition = {"url": "https://private.example", "args": ["secret-argument"],
                      "env": {"TOKEN": "secret-token"}, "headers": {"Authorization": "secret-header"}}
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(custom)}):
            for path, names in [
                (tools.claude_user_config(), ["hive_coder", "hive_playwright"]),
                (custom / "mcp.json", ["custom_tool"]),
                (self.home / ".claude/mcp.json", ["hive_playwright", "claude_tool"]),
                (self.home / ".mcp.json", ["hive_playwright", "home_tool"]),
            ]:
                self.write(path, {"mcpServers": {name: definition for name in names}})
            with patch.object(tools, "run", side_effect=[(0, "2.1.170"), (0, '{"loggedIn": true}'), (0, '[]')]):
                result = tools.inventory("claude")
        self.assertEqual(result["connections"], [
            {"name": name, "enabled": True, "auth": "unknown"}
            for name in ["claude_tool", "custom_tool", "hive_coder", "hive_playwright", "home_tool"]
        ])
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("private", json.dumps(result))
        self.assertEqual(result["warnings"], [])

    def test_claude_inventory_reads_other_configs_when_one_is_malformed(self):
        self.write(self.home / ".mcp.json", {"mcpServers": {"hive_playwright": {}}})
        path = tools.claude_user_config()
        path.parent.mkdir(parents=True, exist_ok=True)
        for content in ['invalid "secret"', '{"mcpServers": ["secret"]}']:
            with self.subTest(content=content):
                path.write_text(content)
                with patch.object(tools, "run", side_effect=[(0, "2.1.170"), (0, '{"loggedIn": true}'), (0, '[]')]):
                    result = tools.inventory("claude")
                self.assertEqual([item["name"] for item in result["connections"]], ["hive_playwright"])
                self.assertEqual(result["warnings"], ["Some Claude MCP configuration could not be read."])
                self.assertNotIn("secret", json.dumps(result))

    def test_specialists_cannot_configure_coder(self):
        with patch.dict(os.environ, {"HIVE_WORKSPACE_PROFILE": "browser"}), patch.object(tools, "run") as run:
            with self.assertRaises(ValueError):
                tools.configure_coder()
        run.assert_not_called()

    def test_coder_setup_validates_both_configs_before_writing(self):
        self.write(tools.claude_user_config(), {"mcpServers": []})
        with patch.object(tools, "run", return_value=(0, "--allowed-tools")):
            with self.assertRaises(ValueError):
                tools.configure_coder()
        self.assertFalse((self.home / ".codex/config.toml").exists())


if __name__ == "__main__":
    unittest.main()
