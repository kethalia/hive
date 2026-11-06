"""Actual isolated tmux + filesystem checks; never uses the primary web socket."""
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/hive-workspace-read.py"
spec = importlib.util.spec_from_file_location("workspace_read", SOURCE)
read = importlib.util.module_from_spec(spec)
spec.loader.exec_module(read)


class WorkspaceReadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hive-workspace-read-")
        self.home = Path(self.temp.name)
        self.root = self.home / "projects"
        self.root.mkdir()
        self.sockets = self.home / "socket-boundary"
        self.sockets.mkdir(mode=0o700)
        self.env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "LANG": "C.UTF-8", "TMUX_TMPDIR": str(self.sockets)}
        self.config = {"profile": "software", "projectsRoot": str(self.root), "home": str(self.home), "socketDirectory": str(self.sockets)}

    def tearDown(self):
        # This exact private fixture directory comes only from setUp.
        subprocess.run(["/usr/bin/tmux", "-L", "web", "kill-server"], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
        self.temp.cleanup()

    def create(self, name="main", cwd=None):
        subprocess.run(["/usr/bin/tmux", "-L", "web", "-f", "/dev/null", "new-session", "-d", "-s", name,
                        "-c", str(cwd or self.root), "/bin/sleep", "120"], env=self.env,
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)

    def execute(self, operation, **values):
        return read.execute(self.config, {"operation": operation, **values})

    def test_missing_server_reads_are_empty_without_starting_one(self):
        self.assertEqual(self.execute("sessions"), {"sessions": [], "nextCursor": None})
        self.assertEqual(self.execute("directory", sessionName="main"), {"cwd": None, "state": "missing_server"})
        self.assertFalse((self.sockets / f"tmux-{os.getuid()}" / "web").exists())

    def test_actual_sessions_are_read_only_and_clone_list_is_reserved(self):
        for name in ("main", "dev", "git-clone-example"):
            self.create(name)
        before = subprocess.check_output(["/usr/bin/tmux", "-L", "web", "list-sessions", "-F", "#{session_id}:#{session_name}:#{session_windows}"], env=self.env)
        data = self.execute("sessions")
        self.assertEqual([row["name"] for row in data["sessions"]], ["dev", "main"])
        self.assertTrue(all(row["windows"] == 1 for row in data["sessions"]))
        self.assertEqual(self.execute("directory", sessionName="git-clone-example")["cwd"], str(self.root))
        self.assertEqual(subprocess.check_output(["/usr/bin/tmux", "-L", "web", "list-sessions", "-F", "#{session_id}:#{session_name}:#{session_windows}"], env=self.env), before)

    def test_exact_session_target_does_not_adopt_prefix_and_never_accepts_command(self):
        self.create("main-long")
        self.assertEqual(self.execute("directory", sessionName="main")["state"], "missing_session")
        for value in ("main;touch-pwned", "main\nnew-session", "main:0", "$(touch pwned)"):
            with self.assertRaises(read.Rejected):
                self.execute("directory", sessionName=value)
        self.assertFalse((self.root / "pwned").exists())
        with self.assertRaises(read.Rejected):
            read.execute(self.config, {"operation": "directory", "sessionName": "main", "command": "id"})

    def test_paths_preserve_spaces_quotes_and_explicit_unsupported_root_results(self):
        self.create()
        (self.root / "a ' quote.txt").write_text("never returned")
        (self.root / "folder").mkdir()
        outside = self.home / "outside.txt"
        outside.write_text("not returned")
        (self.root / "escape").symlink_to(outside)
        (self.root / "inside").symlink_to(self.root / "folder")
        result = self.execute("paths", sessionName="main", paths=["a ' quote.txt", "folder", "missing", "../outside.txt", "escape", "inside", "bad\nname"])
        self.assertEqual([v["status"] for v in result["candidates"]], ["file", "directory", "missing", "outside_supported_root", "outside_supported_root", "directory", "invalid_path"])
        self.assertNotIn("never returned", json.dumps(result))

    def test_fallback_and_home_resolution_do_not_invent_a_directory(self):
        self.create("other")
        (self.root / "item").write_text("x")
        self.assertEqual(self.execute("paths", sessionName="missing", paths=["item"])["candidates"][0]["status"], "cwd_unavailable")
        result = self.execute("paths", sessionName="missing", fallbackPath=".", paths=["item", "~/projects/item"])
        self.assertEqual(result["source"], "fallback")
        self.assertEqual([v["status"] for v in result["candidates"]], ["file", "file"])

    def test_profile_capability_limits_are_independent_of_caller(self):
        self.create()
        for profile in read.PROFILES:
            self.config["profile"] = profile
            self.assertEqual(self.execute("directory", sessionName="main")["state"], "present")
            if profile in read.FILE_PROFILES:
                self.assertEqual(self.execute("paths", sessionName="main", paths=[])["candidates"], [])
            else:
                with self.assertRaisesRegex(read.Rejected, "unsupported_profile_operation"):
                    self.execute("paths", sessionName="main", paths=[])

    def test_pagination_detects_changed_inventory_and_never_silently_truncates(self):
        for number in range(67):
            self.create(f"s{number:03}")
        first = self.execute("sessions")
        self.assertEqual(len(first["sessions"]), 64)
        second = self.execute("sessions", cursor=first["nextCursor"])
        self.assertEqual(len(second["sessions"]), 3)
        self.assertIsNone(second["nextCursor"])
        self.create("changed")
        with self.assertRaisesRegex(read.Rejected, "stale_cursor"):
            self.execute("sessions", cursor=first["nextCursor"])
        with self.assertRaisesRegex(read.Rejected, "invalid_cursor"):
            self.execute("sessions", cursor="malformed")

    def test_error_diagnostics_do_not_become_an_empty_session_list(self):
        with patch.object(read, "tmux", return_value=(1, b"", b"tool failure; no server running")):
            with self.assertRaisesRegex(read.Rejected, "tmux_unavailable"):
                self.execute("sessions")
        with patch.object(read, "tmux", return_value=(0, b"x:1:1\n" * 1025, b"")):
            with self.assertRaisesRegex(read.Rejected, "too_many_sessions"):
                self.execute("sessions")

    def test_read_command_timeout_reaps_only_its_owned_child(self):
        real = subprocess.Popen
        children = []
        def delayed(argv, **options):
            self.assertEqual(argv[:6], ["/usr/bin/tmux", "-L", "web", "-f", "/dev/null", "list-sessions"])
            child = real(["/bin/sleep", "10"], **options)
            children.append(child)
            return child
        start = time.monotonic()
        with patch.object(read.subprocess, "Popen", side_effect=delayed):
            with self.assertRaisesRegex(read.Rejected, "tmux_timeout"):
                self.execute("sessions")
        self.assertLess(time.monotonic() - start, 3)
        self.assertIsNotNone(children[0].returncode)


if __name__ == "__main__":
    unittest.main()
