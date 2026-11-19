#!/usr/bin/env python3
"""Request one repository credential for the provisioned workspace."""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

CONFIG = Path("/etc/hive-github/config.json")
NAME = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}$")


def repository_name(value):
    value = value.removeprefix("https://github.com/").removeprefix("git@github.com:")
    value = value.removeprefix("github.com/").removesuffix(".git")
    return value if NAME.fullmatch(value) and value.split("/")[1] not in (".", "..") else None


def cli_repository(args):
    for index, arg in enumerate(args):
        if arg in ("-R", "--repo") and index + 1 < len(args):
            return repository_name(args[index + 1])
        if arg.startswith("--repo="):
            return repository_name(arg[7:])
    if len(args) > 2 and args[:2] in (["repo", "view"], ["repo", "clone"]):
        if candidate := repository_name(args[2]):
            return candidate
    if args and args[0] == "api":
        for arg in args[1:]:
            match = re.match(r"^/?repos/([^/?]+/[^/?]+)(?:[/?]|$)", arg)
            if match:
                return repository_name(match[1])
    if os.environ.get("GH_REPO"):
        return repository_name(os.environ["GH_REPO"])
    remote = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True)
    return repository_name(remote.stdout.strip())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def token(repository):
    cfg = json.loads(CONFIG.read_text())
    origin = urlsplit(cfg["origin"])
    if origin.scheme != "https" or origin.username or origin.password or origin.path or origin.fragment or origin.query:
        raise ValueError("Invalid Hive origin")
    data = json.dumps({"workspaceId": cfg["workspaceId"], "repository": repository}).encode()
    req = urllib.request.Request(cfg["origin"] + "/api/github/workspace-token", data=data, headers={
        "Authorization": "Bearer " + cfg["key"], "Content-Type": "application/json"})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as res:
        credential = json.loads(res.read(16384))["token"]
    if not re.fullmatch(r"[A-Za-z0-9._~-]{1,8192}", credential):
        raise ValueError("Invalid credential")
    return credential


def main(args):
    if args[0] == "git":
        if args[1:] != ["get"]:
            return
        fields = dict(line.rstrip("\n").split("=", 1) for line in sys.stdin if "=" in line)
        if fields.get("protocol") != "https" or fields.get("host") != "github.com":
            return
        name = repository_name(fields.get("path", ""))
    else:
        if args[1:2] == ["auth"] and args[2:3] not in (["status"], ["token"]):
            sys.exit("Manage this workspace’s GitHub connection in Hive Permissions.")
        name = cli_repository(args[1:])
    if not name and args[0] != "git":
        sys.exit("Choose a GitHub repository with -R OWNER/REPO or GH_REPO, or run inside its clone.")
    if not name:
        raise ValueError("Choose a GitHub repository with -R OWNER/REPO or GH_REPO, or run inside its clone.")
    credential = token(name)
    if args[0] == "git":
        print("username=x-access-token\npassword=" + credential)
    else:
        binary = str(Path.home() / ".local/libexec/gh-app-client")
        os.execve(binary, [binary, *args[1:]], {**os.environ, "GH_HOST": "github.com", "GH_TOKEN": credential})


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except urllib.error.HTTPError as exc:
        if sys.argv[1:2] == ["git"]:
            print("quit=true")
            sys.exit(0)
        sys.exit("GitHub workspace credential unavailable (HTTP %d). Check Permissions in Hive." % exc.code)
    except (OSError, KeyError, ValueError):
        if sys.argv[1:2] == ["git"]:
            print("quit=true")
            sys.exit(0)
        sys.exit("GitHub workspace credential unavailable. Check Permissions in Hive.")
