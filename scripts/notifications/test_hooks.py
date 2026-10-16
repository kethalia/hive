import contextlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock
from unittest.mock import patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("agent_hook", ROOT / "agent-hook.py")
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class NotificationHookTests(unittest.TestCase):
    def test_classification(self):
        for tool in ("AskUserQuestion", "ExitPlanMode", "request_user_input", "request_user_input_async"):
            self.assertEqual(hook.classify({"hook_event_name": "PreToolUse", "tool_name": tool}), "question")
        self.assertEqual(hook.classify({"hook_event_name": "PermissionRequest"}), "approval")
        self.assertEqual(hook.classify({"hook_event_name": "Stop"}), "ready")
        self.assertEqual(hook.classify({"hook_event_name": "StopFailure"}), "failure")
        for event in ({"hook_event_name": "PreToolUse", "tool_name": "Bash"},
                      {"hook_event_name": "Notification", "notification_type": "idle_prompt"}):
            self.assertIsNone(hook.classify(event))

    def test_sender_retries_without_sending_prompt_contents(self):
        opener = MagicMock()
        opener.open.side_effect = [urllib.error.URLError("offline"), MagicMock()]
        event = {"hook_event_name": "PreToolUse", "tool_name": "request_user_input",
                 "session_id": "session", "turn_id": "turn", "tool_input": {"questions": "private prompt"}}
        with patch("sys.argv", ["agent-hook.py", "codex"]), patch("sys.stdin", io.StringIO(json.dumps(event))), patch("pathlib.Path.read_text", return_value=json.dumps({"url": "https://hive.test/api/notifications/events", "token": "scoped-secret"})), patch("urllib.request.build_opener", return_value=opener), patch("time.sleep"), patch.dict("os.environ", {}, clear=True):
            hook.main()
        self.assertEqual(opener.open.call_count, 2)
        request = opener.open.call_args[0][0]
        payload = json.loads(request.data)
        self.assertEqual(payload["kind"], "question")
        self.assertEqual(set(payload), {"kind", "agent", "eventId", "sessionName"})
        self.assertNotIn("private prompt", request.data.decode())
        self.assertEqual(request.get_header("Authorization"), "Bearer scoped-secret")

    def test_install_preserves_user_configuration_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            codex = home / ".codex/hooks.json"
            claude = home / ".claude/settings.json"
            codex.parent.mkdir()
            claude.parent.mkdir()
            original = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "user-custom"}]}]}}
            codex.write_text(json.dumps(original))
            claude.write_text(json.dumps({**original, "theme": "dark"}))
            bundle = json.dumps({"url": "https://hive.test/api/notifications/events", "token": "secret", "hook": "# fixture"})
            for _ in range(2):
                with patch("pathlib.Path.home", return_value=home), patch.dict("os.environ", {}, clear=True), patch("sys.stdin", io.StringIO(bundle)), contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(ROOT / "install.py"))
            for path in (codex, claude):
                data = json.loads(path.read_text())
                self.assertEqual(len(data["hooks"]["Stop"]), 2)
                self.assertEqual(data["hooks"]["Stop"][0]["hooks"][0]["command"], "user-custom")
                self.assertIn("PermissionRequest", data["hooks"])
            self.assertEqual(json.loads(claude.read_text())["theme"], "dark")
            self.assertEqual((home / ".local/share/hive/notifications/config.json").stat().st_mode & 0o777, 0o600)

    def test_invalid_configuration_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            path = home / ".codex/hooks.json"
            path.parent.mkdir()
            path.write_text("invalid user JSON")
            with patch("pathlib.Path.home", return_value=home), patch.dict("os.environ", {}, clear=True), patch("sys.stdin", io.StringIO('{}')):
                with self.assertRaises(json.JSONDecodeError):
                    runpy.run_path(str(ROOT / "install.py"))
            self.assertEqual(path.read_text(), "invalid user JSON")


if __name__ == "__main__":
    unittest.main()
