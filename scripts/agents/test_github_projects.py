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

SOURCE = Path(__file__).resolve().parents[2] / "scripts/agent-bridge/github-projects.py"
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
        with patch.object(discovery, "workspace_token", return_value="private-test-token"), patch.object(
            discovery.urllib.request, "build_opener", return_value=opener
        ):
            result = discovery.discover(request or {"schemaVersion": 1})
        return result, opener.open.call_args

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
        with patch.object(discovery, "workspace_token", return_value="same-private-token") as token, patch.object(
            discovery.urllib.request, "build_opener", return_value=opener
        ):
            self.assertEqual(discovery.discover({"schemaVersion": 1})["providerAccountId"], "123")
        token.assert_called_once()
        self.assertEqual([call.args[0].get_header("Authorization") for call in opener.open.call_args_list], ["Bearer same-private-token"] * 2)
        self.assertEqual(opener.open.call_args_list[0].args[0].full_url, "https://api.github.com/user")
        opener.open.side_effect = [Response({"id": 123}), urllib.error.HTTPError("https://api.github.com/user/repos", 401, "private-token", {}, io.BytesIO())]
        with patch.object(discovery, "workspace_token", return_value="same-private-token"), patch.object(
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
            with self.subTest(value=value), patch.object(discovery, "workspace_token") as token:
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
            with self.subTest(status=status), patch.object(discovery, "workspace_token", return_value="secret"), patch.object(
                discovery.urllib.request, "build_opener", return_value=opener
            ), self.assertRaisesRegex(discovery.DiscoveryError, f"^{code}$"):
                discovery.discover({"schemaVersion": 1})

    def test_device_connections_are_isolated_and_reconnect_preserves_previous_login(self):
        # Simulate native gh's private config independently in two workspace homes.
        def native_identity():
            hosts = Path.home() / ".config/gh/hosts.yml"
            return hosts.read_text() if hosts.exists() else None
        def run(args, config=None, input_data=None):
            hosts = Path.home() / ".config/gh/hosts.yml"
            if args[1] == "login":
                hosts.parent.mkdir(parents=True, exist_ok=True)
                hosts.write_text("octocat")
            if args[1] == "logout":
                hosts.unlink()
            return subprocess.CompletedProcess(args, 0)
        def stage(directory):
            path = Path(tempfile.mkdtemp(prefix="login-", dir=directory))
            return {"stage":path.name, "code":"TEST-CODE","expiresAt":9999999999999,"interval":3}
        action = discovery.github_connection
        with (tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as other,
              patch.dict(os.environ, {"HOME":home, "HIVE_GITHUB_WORKSPACE":"0"*36,
                                      "GH_TOKEN":"inherited", "CODER_AGENT_TOKEN":"global"}),
              patch.object(discovery,"start_cli",side_effect=stage),
              patch.object(discovery,"gh_run",side_effect=run),
              patch.object(discovery,"native_identity",side_effect=native_identity),
              patch.object(discovery,"cli_token",return_value="private-test-token")):
            start = action({"action":"start","revision":"initial"})
            self.assertEqual(start["pending"]["code"], "TEST-CODE")
            self.assertNotIn("stage", start["pending"])
            path = next(discovery.state_directory().glob("login-*"))
            (path / "done").write_text("0")
            connected = action({"action":"poll","revision":start["revision"]})
            self.assertEqual(connected["login"], "octocat")
            self.assertNotIn("private-test-token", json.dumps(connected))
            retry = action({"action":"start","revision":connected["revision"]})
            with patch.dict(os.environ, {"HOME":other, "HIVE_GITHUB_WORKSPACE":"1"*36}):
                self.assertIsNone(action({"action":"status"})["login"])
            stale = action({"action":"disconnect","revision":connected["revision"]})
            self.assertEqual(stale["revision"],retry["revision"])
            restored = action({"action":"cancel","revision":retry["revision"]})
            self.assertEqual(restored["login"],"octocat")
            self.assertIsNone(action({"action":"disconnect","revision":restored["revision"]})["login"])
        _, env = discovery.cli()
        self.assertNotIn("GH_TOKEN",env)
        self.assertNotIn("CODER_AGENT_TOKEN",env)

    def test_main_returns_only_sanitized_structured_errors(self):
        output = io.StringIO()
        with patch.object(discovery.sys, "stdin") as stdin, patch.object(discovery, "discover", side_effect=RuntimeError("private-token")), contextlib.redirect_stdout(output):
            stdin.buffer = io.BytesIO(b'{"schemaVersion":1}')
            self.assertEqual(discovery.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"schemaVersion": 1, "error": "discovery_unavailable"})


if __name__ == "__main__":
    unittest.main()
