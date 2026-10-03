"""Regression tests for evidence classification; these do not prove host isolation."""
import errno
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "templates/ai-dev-k8s/scripts/codex-sandbox-readiness.py"
spec = importlib.util.spec_from_file_location("readiness", source)
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


def completed(operation, outcome="allowed", error=None):
    return {"status": 0, "stdout": json.dumps({"probe": operation, "outcome": outcome, "errno": error}), "stderr": ""}


class EvidenceTests(unittest.TestCase):
    def test_startup_failure_is_not_denial_even_with_a_forged_marker(self):
        result = completed("outside", "error", errno.EACCES)
        result.update(status=1, stderr="bwrap: Failed to make / slave: Permission denied")
        self.assertEqual(readiness.classify(result, "outside"), "unavailable")

    def test_timeouts_signals_missing_tools_and_invalid_output_are_not_denials(self):
        for result in [{"error": "timeout"}, {"error": "FileNotFoundError"},
                       {"status": -9}, {"status": 127}, {"status": 0, "stdout": "[]"},
                       {"status": 0, "stdout": ""}, completed("inside", "error", errno.EACCES)]:
            with self.subTest(result=result):
                self.assertEqual(readiness.classify(result, "outside"), "unavailable")

    def test_only_explicit_boundary_errors_count(self):
        for operation, error in [("outside", errno.ENOENT), ("symlink", errno.EACCES),
                                 ("write", errno.EROFS), ("network", errno.EPERM)]:
            self.assertEqual(readiness.classify(completed(operation, "error", error), operation), "denied")
        for error in [errno.ETIMEDOUT, errno.ECONNREFUSED, errno.ENETUNREACH, None]:
            self.assertEqual(readiness.classify(completed("network", "error", error), "network"), "unavailable")
        self.assertEqual(readiness.classify(completed("write", "error", errno.ENOENT), "write"), "unavailable")

    def test_allowed_escape_is_reported(self):
        self.assertEqual(readiness.classify(completed("outside"), "outside"), "allowed")

    def test_subprocess_timeout_and_missing_executable(self):
        self.assertEqual(readiness.run(["/nonexistent/hive-test-tool"])["error"], "FileNotFoundError")
        self.assertEqual(readiness.run([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.05),
                         {"error": "timeout"})

    def test_mismatched_cli_never_runs_sandbox(self):
        calls = []
        def fake_run(argv, **_):
            calls.append(argv)
            return {"status": 0, "stdout": "codex-cli 0.159.0\n", "stderr": ""}
        with patch.object(readiness.shutil, "which", return_value="/fake/codex"), patch.object(readiness, "run", fake_run):
            report = readiness.diagnose("codex")
        self.assertFalse(report["passed"])
        self.assertFalse(any("sandbox" in argv for argv in calls))
        self.assertIn("mismatch", report["blocker"])

    def test_failure_cannot_be_hidden_by_passing_other_cases(self):
        for failed in [None, "inside", "outside", "symlink", "write", "network", "control"]:
            def fake_run(argv, **_):
                if argv[0] == "unshare":
                    return {"status": 0, "stdout": "", "stderr": ""}
                if "--version" in argv:
                    return {"status": 0, "stdout": readiness.CODEX_VERSION, "stderr": ""}
                operation = argv[-2]
                if "sandbox" not in argv:
                    return {"error": "timeout"} if failed == "control" else completed(operation)
                if operation == failed:
                    return {"status": 1, "stderr": "bwrap startup failure", "stdout": ""}
                return completed(operation) if operation == "inside" else completed(operation, "error", errno.EACCES)
            with patch.object(readiness.shutil, "which", return_value="/fake/codex"), patch.object(readiness, "run", fake_run):
                report = readiness.diagnose("codex")
            self.assertEqual(report["passed"], failed is None, failed)


if __name__ == "__main__":
    unittest.main()
