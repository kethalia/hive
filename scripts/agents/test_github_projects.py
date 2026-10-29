"""Exercise discovery with private fake CLI credentials and bounded fake GitHub responses."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "templates/ai-dev-k8s/scripts/github-projects.py"
SPEC = importlib.util.spec_from_file_location("github_projects", SOURCE)
discovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(discovery)


def repo(identifier=42, name="hive", owner="kethalia", **extra):
    return {"id": identifier, "node_id": f"R_{identifier}", "name": name,
            "full_name": f"{owner}/{name}", "owner": {"login": owner},
            "default_branch": "main", "private": True, "archived": False,
            "permissions": {"pull": True, "push": False, "admin": False}, **extra}


class Response(io.BytesIO):
    status = 200

    def __init__(self, value, link=""):
        super().__init__(value if isinstance(value, bytes) else json.dumps(value).encode())
        self.headers = {"Link": link}


class ProjectsTests(unittest.TestCase):
    def discover(self, payload, link="", request=None):
        opener = unittest.mock.Mock()
        opener.open.side_effect = [Response({"id": 123}), Response(payload, link)]
        with patch.object(discovery, "external_token", return_value="private-test-token"), patch.object(
            discovery.urllib.request, "build_opener", return_value=opener
        ):
            result = discovery.discover(request or {"schemaVersion": 1})
        return result, opener.open.call_args

    def test_resolve_stable_id_account_and_default_revision_without_pagination(self):
        opener = unittest.mock.Mock()
        opener.open.side_effect = [Response({"id":123}), Response(repo(clone_url="https://github.com/kethalia/hive.git")), Response({"sha":"a"*40})]
        with patch.object(discovery,"external_token",return_value="private-test-token"), patch.object(discovery.urllib.request,"build_opener",return_value=opener):
            result=discovery.resolve_repository({"schemaVersion":1,"operation":"resolve","repositoryId":"42","expectedAccountId":"123"})
        self.assertEqual(result["repository"]["providerRepositoryId"],"42")
        self.assertEqual(result["defaultRevision"],"a"*40)
        self.assertEqual([call.args[0].full_url for call in opener.open.call_args_list],["https://api.github.com/user","https://api.github.com/repositories/42","https://api.github.com/repos/kethalia/hive/commits/main"])
        self.assertNotIn("private-test-token",json.dumps(result))

    def test_resolve_rejects_account_switch_stable_id_change_and_clone_url_substitution(self):
        request={"schemaVersion":1,"operation":"resolve","repositoryId":"42","expectedAccountId":"123"}
        for identity, record in [({"id":999},repo()),({"id":123},repo(identifier=43)),({"id":123},repo(clone_url="https://attacker.invalid/repo.git"))]:
            opener=unittest.mock.Mock();opener.open.side_effect=[Response(identity),Response(record)]
            with patch.object(discovery,"external_token",return_value="private-test-token"), patch.object(discovery.urllib.request,"build_opener",return_value=opener):
                with self.assertRaises(discovery.DiscoveryError):discovery.resolve_repository(request)

    def test_fixed_authenticated_endpoint_and_allowlisted_metadata_only(self):
        result, call = self.discover([repo(temp_clone_token="private-test-token", html_url="https://attacker.invalid", description="secret prose")])
        request = call.args[0]
        self.assertTrue(request.full_url.startswith("https://api.github.com/user/repos?"))
        self.assertEqual(request.get_header("Authorization"), "Bearer private-test-token")
        self.assertEqual(request.get_header("X-github-api-version"), "2026-03-10")
        self.assertEqual(call.kwargs["timeout"], discovery.TIMEOUT)
        item = result["repositories"][0]
        self.assertEqual(item["providerRepositoryId"], "42")
        self.assertEqual(result["providerAccountId"], "123")
        self.assertEqual(item["htmlUrl"], "https://github.com/kethalia/hive")
        self.assertEqual(item["permissions"], {"pull": True, "push": False, "admin": False})
        self.assertNotIn("private-test-token", json.dumps(result))
        self.assertNotIn("secret prose", json.dumps(result))
        self.assertNotIn("attacker.invalid", json.dumps(result))

    def test_stable_ids_survive_rename_transfer_and_missing_permissions_stay_unknown(self):
        before, _ = self.discover([repo()])
        after, _ = self.discover([repo(name="renamed", owner="new-owner", permissions={})])
        self.assertEqual(before["repositories"][0]["providerRepositoryId"], after["repositories"][0]["providerRepositoryId"])
        self.assertEqual(after["repositories"][0]["permissions"], {"pull": None, "push": None, "admin": None})

    def test_identity_and_repositories_share_one_captured_token_and_revoke_atomically(self):
        opener = unittest.mock.Mock()
        opener.open.side_effect = [Response({"id": 123}), Response([repo()])]
        with patch.object(discovery, "external_token", return_value="same-private-token") as token, patch.object(
            discovery.urllib.request, "build_opener", return_value=opener
        ):
            self.assertEqual(discovery.discover({"schemaVersion": 1})["providerAccountId"], "123")
        token.assert_called_once()
        self.assertEqual([call.args[0].get_header("Authorization") for call in opener.open.call_args_list], ["Bearer same-private-token"] * 2)
        self.assertEqual(opener.open.call_args_list[0].args[0].full_url, "https://api.github.com/user")
        opener.open.side_effect = [Response({"id": 123}), urllib.error.HTTPError("https://api.github.com/user/repos", 401, "private-token", {}, io.BytesIO())]
        with patch.object(discovery, "external_token", return_value="same-private-token"), patch.object(
            discovery.urllib.request, "build_opener", return_value=opener
        ), self.assertRaisesRegex(discovery.DiscoveryError, "^github_auth_required$"):
            discovery.discover({"schemaVersion": 1})

    def test_pagination_reconstructs_numeric_next_page(self):
        link = '<https://api.github.com/user/repos?page=2&per_page=1&sort=full_name&direction=asc&visibility=all>; rel="next", <https://api.github.com/user/repos?page=5&per_page=1>; rel="last"'
        result, _ = self.discover([repo()], link, {"schemaVersion": 1, "perPage": 1})
        self.assertEqual(result["nextPage"], 2)
        last, call = self.discover([], request={"schemaVersion": 1, "page": 2, "perPage": 1})
        self.assertIsNone(last["nextPage"])
        self.assertIn("page=2", call.args[0].full_url)

    def test_invalid_pagination_cannot_redirect_or_change_visibility(self):
        for url in [
            "https://attacker.invalid/user/repos?page=2&per_page=100",
            "https://api.github.com@attacker.invalid/user/repos?page=2&per_page=100",
            "http://api.github.com/user/repos?page=2&per_page=100",
            "https://api.github.com/user/repos?page=3&per_page=100",
            "https://api.github.com/repos?page=2&per_page=100",
            "https://api.github.com/user/repos?page=2&per_page=100&visibility=public",
            "https://api.github.com/user/repos?page=2&page=3&per_page=100",
        ]:
            with self.subTest(url=url), self.assertRaisesRegex(discovery.DiscoveryError, "github_invalid_pagination"):
                self.discover([], f'<{url}>; rel="next"')

    def test_request_cannot_choose_provider_origin_command_or_unbounded_page(self):
        for value in [None, [], {"schemaVersion": True}, {"schemaVersion": 1, "url": "https://attacker.invalid"},
                      {"schemaVersion": 1, "provider": "other"}, {"schemaVersion": 1, "page": 0},
                      {"schemaVersion": 1, "page": True}, {"schemaVersion": 1, "page": 10001},
                      {"schemaVersion": 1, "perPage": 101}]:
            with self.subTest(value=value), patch.object(discovery, "external_token") as token:
                with self.assertRaises(discovery.DiscoveryError):
                    discovery.discover(value)
                token.assert_not_called()

    def test_invalid_or_oversize_provider_data_fails_without_partial_results(self):
        for value in [b"not JSON secret", {}, [repo(), repo()], [repo(id=True)], [repo(full_name="other/hive")],
                      [repo(name="../escape")], [repo(private="true")], [repo(permissions="admin")],
                      b"x" * (discovery.RESPONSE_LIMIT + 1)]:
            with self.subTest(value=str(value)[:60]), self.assertRaises(discovery.DiscoveryError):
                self.discover(value)

    def test_auth_revocation_permission_rate_and_redirect_errors_are_sanitized(self):
        cases = [(401, {}, "github_auth_required"), (403, {}, "github_permission_denied"),
                 (403, {"X-RateLimit-Remaining": "0"}, "github_rate_limited"),
                 (429, {}, "github_rate_limited"), (302, {}, "github_redirect_rejected"),
                 (500, {}, "github_unavailable")]
        for status, headers, code in cases:
            error = urllib.error.HTTPError("https://secret.invalid", status, "private-token", headers, io.BytesIO(b"secret"))
            opener = unittest.mock.Mock()
            opener.open.side_effect = error
            with self.subTest(status=status), patch.object(discovery, "external_token", return_value="secret"), patch.object(
                discovery.urllib.request, "build_opener", return_value=opener
            ), self.assertRaisesRegex(discovery.DiscoveryError, f"^{code}$"):
                discovery.discover({"schemaVersion": 1})

    def fake_cli(self, directory, script):
        executable = Path(directory) / "coder"
        executable.write_text(f"#!{sys.executable}\n" + script)
        executable.chmod(0o700)
        return {"PATH": directory, "HOME": directory, "CODER_AGENT_TOKEN": "private-agent-token",
                "CODER_AGENT_URL": "https://coder.example.com", "CODER_SESSION_TOKEN": "owner-token",
                "CODER_HEADER_COMMAND": "never-run", "CODER_VERBOSE": "true"}

    def test_cli_uses_agent_only_private_config_and_never_token_arguments(self):
        script = '''import json, os, pathlib, sys
pathlib.Path(os.environ["HOME"], "captured.json").write_text(json.dumps({"env": dict(os.environ), "args": sys.argv}))
print("private-provider-token")
'''
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, self.fake_cli(directory, script), clear=True):
                self.assertEqual(discovery.external_token(), "private-provider-token")
            capture = json.loads((Path(directory) / "captured.json").read_text())
            for key in ["CODER_SESSION_TOKEN", "CODER_HEADER_COMMAND", "CODER_VERBOSE"]:
                self.assertNotIn(key, capture["env"])
            self.assertNotIn("private-agent-token", str(capture["args"]))
            args = capture["args"]
            self.assertIn("--use-keyring=false", args)
            self.assertEqual(args[-5:], ["external-auth", "access-token", "github", "--auth", "token"])
            self.assertFalse(Path(args[args.index("--global-config") + 1]).exists())

    def test_cli_failure_cannot_return_auth_url_or_secret_and_output_is_bounded(self):
        for script, code in [
            ('print("https://coder.example.com/auth?secret=private-token"); raise SystemExit(1)', "github_auth_required"),
            ('print("x"*4097)', "external_auth_invalid_response"),
            ('print("invalid token\\nprivate-token")', "external_auth_invalid_response"),
        ]:
            with tempfile.TemporaryDirectory() as directory, self.subTest(code=code):
                with patch.dict(os.environ, self.fake_cli(directory, script), clear=True):
                    with self.assertRaisesRegex(discovery.DiscoveryError, f"^{code}$"):
                        discovery.external_token()

    def test_cli_timeout_is_bounded_and_missing_agent_never_uses_owner_auth(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(discovery, "TIMEOUT", 0.05):
            with patch.dict(os.environ, self.fake_cli(directory, "import time; time.sleep(30)"), clear=True):
                with self.assertRaisesRegex(discovery.DiscoveryError, "external_auth_timeout"):
                    discovery.external_token()
        with patch.dict(os.environ, {"CODER_SESSION_TOKEN": "owner-token"}, clear=True), patch.object(discovery.subprocess, "Popen") as process:
            with self.assertRaisesRegex(discovery.DiscoveryError, "workspace_agent_required"):
                discovery.external_token()
            process.assert_not_called()

    def test_main_returns_only_sanitized_structured_errors(self):
        output = io.StringIO()
        with patch.object(discovery.sys, "stdin") as stdin, patch.object(discovery, "discover", side_effect=RuntimeError("private-token")), contextlib.redirect_stdout(output):
            stdin.buffer = io.BytesIO(b'{"schemaVersion":1}')
            self.assertEqual(discovery.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"schemaVersion": 1, "error": "discovery_unavailable"})


if __name__ == "__main__":
    unittest.main()
