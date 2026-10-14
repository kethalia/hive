#!/usr/bin/env python3
"""Create and retire task disposables using signed primary-owned Coder receipts.

This guards the automatic workflow, not a primary process holding owner credentials.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid


SPECIALISTS = {"browser-testing", "game-dev", "electronics", "infrastructure"}
IDENTITY = ("id", "owner_id", "template_id", "created_at")


def identifier(value):
    return str(uuid.UUID(value))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("Coder redirects are not permitted")


class Coder:
    def __init__(self):
        config = Path(os.environ.get("CODER_CONFIG_DIR", Path.home() / ".config/coderv2"))
        self.url = (os.environ.get("CODER_URL") or (config / "url").read_text()).strip().rstrip("/")
        parsed = urllib.parse.urlsplit(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.query or parsed.fragment:
            raise ValueError("Invalid Coder deployment URL")
        self.token = os.environ.get("CODER_SESSION_TOKEN") or (config / "session").read_text().strip()
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, body=None):
        request = urllib.request.Request(
            self.url + "/api/v2" + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Coder-Session-Token": self.token, "Content-Type": "application/json"},
            method=method,
        )
        with self.opener.open(request, timeout=30) as response:
            return json.load(response)


class Workspaces:
    def __init__(self, home, api, primary):
        self.home = Path(home).resolve()
        self.state = self.home / ".local/state/hive/workspaces"
        self.api = api
        self.primary = identifier(primary)

    def private(self, path, directory=False):
        if path.resolve() != path or not path.is_relative_to(self.home):
            raise ValueError("Symlinked workspace state is not permitted")
        info = path.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Workspace state must be private to the primary user")
        if directory != stat.S_ISDIR(info.st_mode) or (not directory and not stat.S_ISREG(info.st_mode)):
            raise ValueError("Invalid workspace state type")

    @contextmanager
    def lock(self):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.private(self.state, directory=True)
        fd = os.open(self.state / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            key = self.state / "key"
            if not key.exists():
                out = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(out, "wb") as stream:
                    stream.write(os.urandom(32))
            self.private(key)
            self.key = key.read_bytes()
            if len(self.key) != 32:
                raise ValueError("Invalid workspace receipt key")
            yield
        finally:
            os.close(fd)

    def signature(self, record):
        return hmac.new(self.key, json.dumps(record, sort_keys=True).encode(), hashlib.sha256).hexdigest()

    def save(self, record, new=False):
        target = self.state / (identifier(record["id"]) + ".json")
        fd, temporary = tempfile.mkstemp(dir=self.state)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump({"record": record, "signature": self.signature(record)}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            if new:
                os.link(temporary, target)
            else:
                os.replace(temporary, target)
        finally:
            os.unlink(temporary) if os.path.exists(temporary) else None

    def load(self, workspace, task):
        path = self.state / (identifier(workspace) + ".json")
        self.private(path)
        envelope = json.loads(path.read_text())
        record = envelope["record"]
        if not hmac.compare_digest(envelope["signature"], self.signature(record)):
            raise ValueError("Invalid workspace receipt signature")
        if (record["id"] != workspace or record["task"] != task or
                record["primary"] != self.primary or record["deployment"] != self.api.url):
            raise ValueError("Workspace receipt does not match this task, primary, or deployment")
        if record["id"] == self.primary or record["template_name"] not in SPECIALISTS:
            raise ValueError("Primary and non-specialist workspaces cannot be retired")
        return record

    def fresh(self, record):
        workspace = self.api.request("GET", "/workspaces/" + record["id"])
        if any(workspace.get(field) != record[field] for field in IDENTITY):
            raise ValueError("Coder workspace identity changed; retaining workspace")
        return workspace

    def create(self, task, name, template, parameters):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,30}[A-Za-z0-9]|[A-Za-z0-9]", name):
            raise ValueError("Invalid workspace name")
        template = identifier(template)
        spec = self.api.request("GET", "/templates/" + template)
        if spec.get("id") != template or spec.get("name") not in SPECIALISTS:
            raise ValueError("Only specialist templates can create disposables")
        owner = self.api.request("GET", "/users/me")["id"]
        workspace = self.api.request("POST", "/users/me/workspaces", {
            "name": name, "template_id": template, "rich_parameter_values": parameters,
            "automatic_updates": "never",
        })
        if workspace.get("owner_id") != owner or workspace.get("template_id") != template:
            raise ValueError("Creation response identity mismatch; retaining workspace")
        record = {field: workspace[field] for field in IDENTITY}
        record["id"] = identifier(record["id"])
        if record["id"] == self.primary:
            raise ValueError("Refusing a primary workspace creation response")
        record.update(deployment=self.api.url, primary=self.primary, task=task, name=workspace["name"],
                      template_name=spec["name"], status="active")
        self.save(record, new=True)
        return record

    def complete(self, workspace, task, evidence):
        record = self.load(workspace, task)
        if record["status"] != "active":
            raise ValueError("Only active tasks can be completed")
        evidence = Path(evidence).absolute()
        if evidence.resolve() != evidence or not evidence.is_relative_to(self.home / "projects") or not evidence.is_file():
            raise ValueError("Preserve evidence as a regular file in the primary projects directory")
        self.fresh(record)
        record.update(status="complete", evidence=str(evidence),
                      evidence_sha256=hashlib.sha256(evidence.read_bytes()).hexdigest())
        self.save(record)
        return record

    def cleanup(self, workspace, task):
        record = self.load(workspace, task)
        if record["status"] != "complete":
            raise ValueError("Task is still active; retaining workspace")
        evidence = Path(record["evidence"])
        if evidence.resolve() != evidence or hashlib.sha256(evidence.read_bytes()).hexdigest() != record["evidence_sha256"]:
            raise ValueError("Preserved evidence changed; retaining workspace")
        current = self.fresh(record)
        status = current["latest_build"]["status"]
        if status == "running":
            self.api.request("POST", "/workspaces/" + record["id"] + "/builds", {"transition": "stop"})
            return {"id": record["id"], "status": "stopping", "next": "rerun cleanup after stop succeeds"}
        if status != "stopped":
            raise ValueError("Workspace must be successfully stopped before deletion")
        # Repeat identity and build checks immediately before the destructive request.
        checked = self.fresh(record)
        if (checked["latest_build"]["id"] != current["latest_build"]["id"] or
                checked["latest_build"]["status"] != "stopped"):
            raise ValueError("Workspace build changed; retaining workspace")
        self.api.request("POST", "/workspaces/" + record["id"] + "/builds", {"transition": "delete"})
        record["status"] = "deleting"
        self.save(record)
        return {"id": record["id"], "status": "deleting"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--task", required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--template", required=True, help="specialist template UUID")
    create.add_argument("--parameter", action="append", default=[], help="name=value")
    for action in ("complete", "cleanup"):
        command = commands.add_parser(action)
        command.add_argument("workspace", type=identifier)
        command.add_argument("--task", required=True)
        if action == "complete":
            command.add_argument("--evidence", required=True)
    args = parser.parse_args()
    if os.environ.get("HIVE_WORKSPACE_PROFILE") != "software":
        parser.error("Only the primary software profile can manage workspace cleanup")
    try:
        workspaces = Workspaces(Path.home(), Coder(), os.environ["CODER_WORKSPACE_ID"])
        with workspaces.lock():
            if args.command == "create":
                parameters = []
                for value in args.parameter:
                    name, separator, value = value.partition("=")
                    if not name or not separator:
                        raise ValueError("Use --parameter name=value")
                    parameters.append({"name": name, "value": value})
                result = workspaces.create(args.task, args.name, args.template, parameters)
            elif args.command == "complete":
                result = workspaces.complete(args.workspace, args.task, args.evidence)
            else:
                result = workspaces.cleanup(args.workspace, args.task)
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Do not print API bodies, headers, URLs, or credentials.
        parser.exit(1, "Workspace operation refused: " + type(error).__name__ + "\n")


if __name__ == "__main__":
    main()
