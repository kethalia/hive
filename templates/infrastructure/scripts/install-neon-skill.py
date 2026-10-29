#!/usr/bin/env python3
"""Install pinned vendor skill data, preserving every existing skill destination."""
import fcntl
import io
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import urllib.request

REVISION = "9df568a3f88a361ea33db00453ff754d07b3b3e1"
URL = f"https://codeload.github.com/neondatabase/agent-skills/tar.gz/{REVISION}"
PREFIX = f"agent-skills-{REVISION}/skills/neon-postgres/"
LIMIT = 16 * 1024 * 1024


def unpack(data, destination):
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            if not member.name.startswith(PREFIX):
                continue
            relative = PurePosixPath(member.name[len(PREFIX):])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe skill archive path")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError("Skill archive links are unsupported")
            total += member.size
            if total > LIMIT:
                raise ValueError("Skill archive exceeds size limit")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o600)
    if not (destination / "SKILL.md").is_file():
        raise ValueError("Pinned archive has no neon-postgres SKILL.md")


def install():
    if os.environ.get("HIVE_WORKSPACE_PROFILE") != "software":
        return
    home = Path.home()
    roots = [home / ".agents", Path(os.environ.get("CODEX_HOME", str(home / ".codex"))),
             Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude")))]
    destinations = list(dict.fromkeys(root / "skills" / "neon-postgres" for root in roots))
    state = home / ".local/share/hive/official-skills"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    update_state = home / ".local/state/hive/agent-updates"
    update_state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (update_state / "update.lock").open("a") as update_lock, (state / ".neon-install.lock").open("a") as lock:
        # Same order as scheduled maintenance/startup; outer command bounds waiting.
        fcntl.flock(update_lock, fcntl.LOCK_EX)
        fcntl.flock(lock, fcntl.LOCK_EX)
        missing = [path for path in destinations if not os.path.lexists(path)]
        if not missing:
            return
        with urllib.request.urlopen(URL, timeout=20) as response:
            data = response.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("Skill download exceeds size limit")
        with tempfile.TemporaryDirectory(prefix=".neon-", dir=state) as temporary:
            source = Path(temporary) / "skill"
            source.mkdir()
            unpack(data, source)
            (source / ".hive-source").write_text(f"{URL}\n{REVISION}\n")
            managed = state / f"neon-{REVISION}"
            if not os.path.lexists(managed):
                source.rename(managed)
            elif not (managed / "SKILL.md").is_file():
                raise ValueError("Existing managed skill requires inspection")
            for destination in missing:
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    destination.symlink_to(managed, target_is_directory=True)
                except FileExistsError:
                    pass  # Preserve directories and links created concurrently.


if __name__ == "__main__":
    os.umask(0o077)
    try:
        install()
    except Exception:
        print("[warn] Neon skill setup deferred; existing skills preserved.")
        raise SystemExit(1)
