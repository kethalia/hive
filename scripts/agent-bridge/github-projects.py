#!/usr/bin/env python3
"""Bounded workspace-local GitHub discovery; never clone or emit credentials.

Protocol: stdin {schemaVersion:1,page?:1,perPage?:100}; stdout one JSON result.
Pagination is explicit. Search belongs over the caller's owner-scoped page cache,
not GitHub's public repository search. No request may choose an API origin/provider.

Sources: https://cli.github.com/manual/gh_auth_login
https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user
Invoked by the signed workspace bridge.
"""
import fcntl
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API_ORIGIN = "https://api.github.com"
REQUEST_LIMIT = 4096
TOKEN_LIMIT = 4096
RESPONSE_LIMIT = 4 * 1024 * 1024
TIMEOUT = 10
MAX_PAGE = 10000
API_VERSION = "2026-03-10"


class DiscoveryError(Exception):
    """Fixed, non-sensitive error codes only; never include provider response text."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_parameters(value):
    if not isinstance(value, dict) or set(value) - {"schemaVersion", "page", "perPage"}:
        raise DiscoveryError("invalid_request")
    if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
        raise DiscoveryError("unsupported_schema")
    page, per_page = value.get("page", 1), value.get("perPage", 100)
    if type(page) is not int or not 1 <= page <= MAX_PAGE:
        raise DiscoveryError("invalid_page")
    if type(per_page) is not int or not 1 <= per_page <= 100:
        raise DiscoveryError("invalid_page_size")
    return page, per_page


def state_directory():
    workspace = os.environ["HIVE_GITHUB_WORKSPACE"]
    if not re.fullmatch(r"[a-f0-9-]{36}", workspace):
        raise DiscoveryError("workspace_agent_required")
    directory = Path.home() / ".local/state/hive/github" / workspace
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise DiscoveryError("workspace_agent_required")
    return directory


def read_state(directory):
    try:
        with (directory / "connection.json").open() as stream:
            return json.load(stream)
    except FileNotFoundError:
        return {"revision": "initial"}


def save_state(directory, state):
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as stream:
        try:
            json.dump(state, stream)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(stream.name, directory / "connection.json")
        finally:
            Path(stream.name).unlink(missing_ok=True)


def cli(config=None):
    binary = Path.home() / ".local/libexec/gh"
    if not binary.is_file():
        binary = shutil.which("gh", path="/usr/local/bin:/usr/bin:/bin")
    if not binary:
        raise DiscoveryError("workspace_agent_required")
    env = {"HOME": str(Path.home()), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C",
           "GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1", "BROWSER": "/bin/true"}
    if config:
        env["GH_CONFIG_DIR"] = str(config)
    return str(binary), env


def gh_run(args, config=None, input_data=None):
    binary, env = cli(config)
    return subprocess.run([binary, *args], env=env, input=input_data or b"",
                          capture_output=True, timeout=TIMEOUT)


def cli_token(config=None):
    result = gh_run(["auth", "token", "--hostname", "github.com"], config)
    if result.returncode:
        return None
    token = result.stdout.strip().decode("ascii")
    if not re.fullmatch(r"[A-Za-z0-9._~-]{1,4096}", token):
        raise DiscoveryError("github_invalid_response")
    return token


def workspace_token():
    token = cli_token()
    if not token:
        raise DiscoveryError("github_auth_required")
    return token


# The helper is launched once per bridge operation. A short-lived supervisor owns
# the real CLI process between requests. Its output stays private to the attempt.
def supervise_cli(stage_name):
    if not re.fullmatch(r"login-[a-z0-9_]{8}", stage_name):
        return 1
    stage = state_directory() / stage_name
    binary, env = cli(stage)
    with (stage / "prompt").open("xb") as output:
        child = subprocess.Popen([binary, "auth", "login", "--hostname", "github.com",
                                  "--git-protocol", "https", "--web", "--insecure-storage"],
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=output, env=env)
    try:
        end = time.monotonic() + 900
        while child.poll() is None and stage.exists() and time.monotonic() < end:
            time.sleep(0.25)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
    if stage.exists():
        (stage / "done").write_text(str(child.returncode))
        # Commit even if Hive closed during approval. The state lock serializes
        # this readback with cancellation, a newer attempt, and ordinary polling.
        github_connection({"action": "status"})
    return 0


def start_cli(directory):
    stage = Path(tempfile.mkdtemp(prefix="login-", dir=directory))
    try:
        # Reuse this exact pinned helper (-I -B -c <source> on the bridge).
        child = subprocess.Popen([sys.executable, *sys.orig_argv[1:], "--supervise-login", stage.name],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        deadline = time.monotonic() + TIMEOUT
        while child.poll() is None and time.monotonic() < deadline:
            prompt = stage / "prompt"
            if prompt.exists():
                with prompt.open("rb") as stream:
                    text = stream.read(4096)
                match = re.search(rb"one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b", text)
                if match and b"https://github.com/login/device" in text:
                    return {"stage": stage.name, "code": match[1].decode(),
                            "expiresAt": int(time.time() * 1000) + 900000, "interval": 3}
            time.sleep(0.1)
        raise DiscoveryError("github_unavailable")
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def native_identity():
    token = cli_token()
    if not token:
        return None
    try:
        identity, _ = github_json(token, "/user")
    except DiscoveryError as error:
        if str(error) == "github_auth_required":
            return None
        raise
    login = identity.get("login")
    if not isinstance(login, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,39}", login):
        raise DiscoveryError("github_invalid_response")
    return login


def github_connection(action):
    directory = state_directory()
    with (directory / "connection.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_state(directory)
        pending = state.get("pending")
        pending_at_entry = bool(pending)
        kind = action["action"]
        matches = action.get("revision") == state["revision"]
        if pending:
            stage = directory / pending["stage"]
            if not re.fullmatch(r"login-[a-z0-9_]{8}", stage.name):
                raise DiscoveryError("github_invalid_response")
            finished = stage / "done"
            outcome = None
            if pending["expiresAt"] <= time.time() * 1000:
                outcome = "expired"
            elif kind == "cancel" and matches:
                outcome = "cancelled"
            elif finished.exists() and kind in ("status", "poll"):
                if finished.read_text() == "0":
                    token = cli_token(stage)
                    if not token or gh_run(["auth", "login", "--hostname", "github.com", "--with-token"],
                                           input_data=token.encode()).returncode:
                        raise DiscoveryError("github_unavailable")
                    # Terminal gh and Git follow the native login after the first approval.
                    (Path.home() / ".config/gh/.hive-workspace-login").touch(mode=0o600)
                    outcome = "approved"
                else:
                    outcome = "failed"
            if outcome:
                state.pop("pending")
                state.update(outcome=outcome if outcome in ("expired","failed") else None,
                             revision=str(uuid.uuid4()))
                save_state(directory, state)
                shutil.rmtree(stage, ignore_errors=True)
                pending = None
        else:
            login = native_identity()
            if login != state.get("login"):
                state.update(login=login, revision=str(uuid.uuid4()))
                save_state(directory, state)
                matches = False
            if matches and kind == "start":
                pending = start_cli(directory)
                state.update(pending=pending, outcome=None, revision=str(uuid.uuid4()))
                save_state(directory, state)
            elif matches and kind == "disconnect" and login:
                (Path.home() / ".config/gh/.hive-workspace-login").touch(mode=0o600)
                accounts = gh_run(["auth", "status", "--hostname", "github.com", "--json", "hosts",
                                   "--jq", '.hosts["github.com"][] | .login'])
                logins = accounts.stdout.decode("utf-8").splitlines()
                if accounts.returncode or login not in logins or not all(
                        re.fullmatch(r"[a-zA-Z0-9-]{1,39}", item) for item in logins):
                    raise DiscoveryError("github_unavailable")
                for item in logins:
                    if gh_run(["auth", "logout", "--hostname", "github.com", "--user", item]).returncode:
                        raise DiscoveryError("github_unavailable")
                if cli_token():
                    raise DiscoveryError("github_unavailable")
                state.update(login=None, outcome=None, revision=str(uuid.uuid4()))
                save_state(directory, state)
        if pending_at_entry and not pending:
            state["login"] = native_identity()
            save_state(directory, state)
        return {"revision": state["revision"], "login": state.get("login"),
                "outcome": state.get("outcome"),
                "pending": ({k: pending[k] for k in ("code", "expiresAt", "interval")}
                            if pending else None)}


def repository(record):
    try:
        identifier = record["id"]
        owner, name = record["owner"]["login"], record["name"]
        node_id = record["node_id"]
        branch = record["default_branch"]
        if (type(identifier) is not int or not 0 < identifier < 10**20 or
                not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", owner) or
                not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", name) or name in {".", ".."} or
                record["full_name"] != f"{owner}/{name}" or
                not isinstance(node_id, str) or not re.fullmatch(r"[A-Za-z0-9_=/+-]{1,256}", node_id) or
                not isinstance(branch, str) or not 1 <= len(branch) <= 255 or
                any(ord(character) < 32 or ord(character) == 127 for character in branch) or
                type(record["private"]) is not bool or type(record["archived"]) is not bool):
            raise DiscoveryError("github_invalid_response")
        permissions = record.get("permissions", {})
        if not isinstance(permissions, dict):
            raise DiscoveryError("github_invalid_response")
        return {"provider": "github", "providerRepositoryId": str(identifier),
                "nodeId": node_id, "fullName": record["full_name"], "name": name,
                "owner": owner, "defaultBranch": branch, "private": record["private"],
                "archived": record["archived"], "htmlUrl": f"https://github.com/{owner}/{name}",
                "permissions": {key: permissions.get(key) if type(permissions.get(key)) is bool else None
                                for key in ("pull", "push", "admin")}}
    except (KeyError, TypeError, AttributeError):
        raise DiscoveryError("github_invalid_response") from None


def next_page(link, page, per_page):
    if not link:
        return None
    if len(link) > 8192:
        raise DiscoveryError("github_invalid_pagination")
    candidates = []
    for section in link.split(","):
        match = re.fullmatch(r'\s*<([^>]+)>;\s*rel="([a-z ]+)"\s*', section)
        if not match:
            raise DiscoveryError("github_invalid_pagination")
        if "next" not in match[2].split():
            continue
        url = urllib.parse.urlsplit(match[1])
        values = urllib.parse.parse_qs(url.query, strict_parsing=True)
        # Never follow a returned URL. Validate its exact fixed endpoint and next
        # numeric page, then reconstruct the request from integers on the next call.
        if (url.scheme != "https" or url.netloc != "api.github.com" or
                url.path != "/user/repos" or url.fragment or
                set(values) - {"page", "per_page", "sort", "direction", "affiliation", "visibility"} or
                values.get("page") != [str(page + 1)] or values.get("per_page") != [str(per_page)] or
                values.get("sort", ["full_name"]) != ["full_name"] or
                values.get("direction", ["asc"]) != ["asc"] or
                values.get("visibility", ["all"]) != ["all"] or
                values.get("affiliation", ["owner,collaborator,organization_member"]) != ["owner,collaborator,organization_member"]):
            raise DiscoveryError("github_invalid_pagination")
        candidates.append(page + 1)
    if len(candidates) > 1:
        raise DiscoveryError("github_invalid_pagination")
    if candidates and page == MAX_PAGE:
        raise DiscoveryError("pagination_limit_reached")
    return candidates[0] if candidates else None


def github_json(token, path):
    if path != "/user" and not path.startswith("/user/repos?"):
        raise DiscoveryError("invalid_request")
    request = urllib.request.Request(f"{API_ORIGIN}{path}", headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION, "User-Agent": "Hive-project-discovery/1",
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            if response.status != 200:
                raise DiscoveryError("github_unavailable")
            deadline = time.monotonic() + TIMEOUT
            payload = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise DiscoveryError("github_timeout")
                chunk = response.read1(min(65536, RESPONSE_LIMIT + 1 - len(payload)))
                if not chunk:
                    break
                payload.extend(chunk)
                if len(payload) > RESPONSE_LIMIT:
                    raise DiscoveryError("github_response_too_large")
            return json.loads(payload), response.headers
    except urllib.error.HTTPError as error:
        if error.code == 401:
            code = "github_auth_required"
        elif error.code == 429 or (error.code == 403 and error.headers.get("X-RateLimit-Remaining") == "0"):
            code = "github_rate_limited"
        elif error.code == 403:
            code = "github_permission_denied"
        elif 300 <= error.code < 400:
            code = "github_redirect_rejected"
        else:
            code = "github_unavailable"
        error.close()
        raise DiscoveryError(code) from None
    except (TimeoutError, urllib.error.URLError):
        raise DiscoveryError("github_unavailable") from None
    except (ValueError, UnicodeDecodeError):
        raise DiscoveryError("github_invalid_response") from None

def discover(value):
    page, per_page = request_parameters(value)
    token = workspace_token()
    # Capture identity and repositories using exactly the same token. A reconnect
    # cannot silently append a different account's repositories to a cached page.
    identity, _ = github_json(token, "/user")
    if not isinstance(identity, dict) or type(identity.get("id")) is not int or not 0 < identity["id"] < 10**20:
        raise DiscoveryError("github_invalid_response")
    query = urllib.parse.urlencode({"page": page, "per_page": per_page, "sort": "full_name",
                                   "direction": "asc", "visibility": "all"})
    records, headers = github_json(token, f"/user/repos?{query}")
    if not isinstance(records, list) or len(records) > per_page:
        raise DiscoveryError("github_invalid_response")
    projects = [repository(record) for record in records]
    if len({item["providerRepositoryId"] for item in projects}) != len(projects):
        raise DiscoveryError("github_invalid_response")
    following = next_page(headers.get("Link", ""), page, per_page)
    return {"schemaVersion": 1, "provider": "github", "providerAccountId": str(identity["id"]),
            "repositories": projects, "page": page, "perPage": per_page, "nextPage": following}


def main():
    try:
        raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        if len(raw) > REQUEST_LIMIT:
            raise DiscoveryError("request_too_large")
        value = json.loads(raw)
        result = github_connection(value["connection"]) if "connection" in value else discover(value)
        status = 0
    except DiscoveryError as error:
        result, status = {"schemaVersion": 1, "error": str(error)}, 1
    except Exception:
        # No traceback, CLI stdout/stderr, token, remote body, or arbitrary URL.
        result, status = {"schemaVersion": 1, "error": "discovery_unavailable"}, 1
    print(json.dumps(result, separators=(",", ":")))
    return status


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--supervise-login":
        sys.exit(supervise_cli(sys.argv[2]))
    sys.exit(main())
