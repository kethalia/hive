import contextlib
import importlib.util
import io
import os
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/github-app-credential.py"
spec = importlib.util.spec_from_file_location("github_app_credential", HELPER)
helper = importlib.util.module_from_spec(spec)
with patch.object(sys, "dont_write_bytecode", True):
    spec.loader.exec_module(helper)


class WorkspaceCredentials(unittest.TestCase):
    def test_normal_gh_entry_points_select_one_repository(self):
        for args in (["pr", "list", "-R", "kethalia/hive"], ["repo", "clone", "kethalia/hive"],
                     ["api", "repos/kethalia/hive/branches"], ["repo", "view", "https://github.com/kethalia/hive"]):
            self.assertEqual(helper.cli_repository(args), "kethalia/hive")
        with patch.dict(os.environ, {"GH_REPO": "chillwhales/lsp-indexer"}):
            self.assertEqual(helper.cli_repository(["release", "list"]), "chillwhales/lsp-indexer")

    def test_git_credentials_are_bound_to_host_and_path(self):
        with patch.object(helper, "token", return_value="fixture-only") as request:
            for host in ["github.com", "elsewhere.invalid"]:
                output = io.StringIO()
                with patch("sys.stdin", io.StringIO("protocol=https\nhost="+host+"\npath=chillwhales/chillwhales-frontend.git\n\n")), contextlib.redirect_stdout(output):
                    helper.main(["git","get"])
                self.assertEqual("password=fixture-only" in output.getvalue(), host=="github.com")
            request.assert_called_once_with("chillwhales/chillwhales-frontend")

    def test_workspace_login_cannot_switch_back_to_personal_credentials(self):
        for command in ["login", "switch", "refresh"]:
            with self.assertRaises(SystemExit), patch.object(helper,"token",side_effect=AssertionError):
                helper.main(["cli","auth",command])

    def test_gh_receives_only_the_broker_credential(self):
        with patch.dict(os.environ,{"GH_TOKEN":"old-personal"}), patch.object(helper,"token",return_value="scoped") as request, patch("os.execve") as run:
            helper.main(["cli","repo","view","kethalia/codex-creative-studio"])
            request.assert_called_once_with("kethalia/codex-creative-studio")
            self.assertEqual(run.call_args.args[2]["GH_TOKEN"],"scoped")


if __name__ == "__main__":
    unittest.main()
