"""Remove this deployment's persisted CLI login before a specialist agent starts."""

import base64
import os
from pathlib import Path
import stat
import sys
from urllib.parse import urlsplit


def deployment(value):
    parsed = urlsplit(value.strip())
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Invalid deployment URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, parsed.hostname.lower(), port, parsed.path.rstrip("/")


def cleanup(expected_url, profile):
    if profile == "software":
        return
    if profile not in {"browser", "game", "electronics", "infrastructure"}:
        raise ValueError("Unknown specialist profile")
    expected = deployment(expected_url)
    home = Path.home().resolve()
    roots = {home / ".config" / "coderv2"}
    if os.environ.get("XDG_CONFIG_HOME"):
        roots.add(Path(os.environ["XDG_CONFIG_HOME"]) / "coderv2")
    if os.environ.get("CODER_CONFIG_DIR"):
        roots.add(Path(os.environ["CODER_CONFIG_DIR"]))
    for root in roots:
        root = root.resolve()
        session = root / "session"
        try:
            before = session.lstat()
        except FileNotFoundError:
            continue
        # Never follow a shared config directory outside this workspace's home.
        if not root.is_relative_to(home):
            raise ValueError("Credential configuration is outside the private workspace home")
        with (root / "url").open() as handle:
            stored_url = handle.read(4097)
        if len(stored_url) > 4096:
            raise ValueError("Invalid deployment URL")
        if deployment(stored_url) != expected:
            continue  # Explicit logins to other deployments are user-owned.
        # A shared/symlinked secret could remain readable after removing its
        # local pointer. Preserve it and require operator cleanup before login.
        if before.st_uid != os.getuid() or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError("Credential file is not a private regular file")
        after = session.lstat()
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise ValueError("Credential file changed during cleanup")
        session.unlink()


if __name__ == "__main__":
    try:
        cleanup(
            base64.b64decode(sys.argv[1], validate=True).decode(),
            base64.b64decode(sys.argv[2], validate=True).decode(),
        )
    except (OSError, ValueError, IndexError):
        # Never put stored tokens, URLs, or credential file contents in logs.
        raise SystemExit("Specialist Coder credential cleanup failed; agent was not started")
