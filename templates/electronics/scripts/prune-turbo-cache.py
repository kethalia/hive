"""Remove only old, untracked Turborepo cache objects; never project outputs."""
import os
from pathlib import Path
import re
import stat
import subprocess
import time


OBJECT = re.compile(r"[0-9a-f]{16}(?:\.tar\.zst|-(?:meta|manifest)\.json)")


def prune(projects, now=None, maximum=2000, apply=False):
    projects = Path(projects)
    now = time.time() if now is None else now
    removed = size = 0
    if projects.is_symlink() or not projects.is_dir():
        return removed, size
    for directory, children, _ in os.walk(projects, followlinks=False):
        children[:] = [n for n in children if n not in {".git", "node_modules", ".next"}
                       and not Path(directory, n).is_symlink()]
        if ".turbo" not in children:
            continue
        children.remove(".turbo")
        cache = Path(directory, ".turbo", "cache")
        if not cache.is_dir() or cache.is_symlink():
            continue
        tracked = subprocess.run(["git", "-C", directory, "ls-files", "--", ".turbo"],
                                 capture_output=True, timeout=10, check=False)
        if tracked.returncode or tracked.stdout:
            continue
        # Open every component without following symlinks, including if a
        # directory changes after os.walk inspected it.
        fd = os.open(projects, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in cache.relative_to(projects).parts:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
        except OSError:
            os.close(fd)
            continue
        try:
            for name in sorted(os.listdir(fd)):
                if removed >= maximum:
                    return removed, size
                if not OBJECT.fullmatch(name):
                    continue
                try:
                    before = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(before.st_mode) or now - before.st_mtime <= 7 * 86400:
                        continue
                    current = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if (before.st_ino, before.st_mtime_ns, before.st_size) != (
                            current.st_ino, current.st_mtime_ns, current.st_size):
                        continue
                    if apply:
                        os.unlink(name, dir_fd=fd)
                    removed += 1
                    size += before.st_size
                except FileNotFoundError:
                    continue  # A build or another maintenance pass won the race.
        finally:
            os.close(fd)
    return removed, size


if __name__ == "__main__":
    count, size = prune(Path.home() / "projects", apply=True)
    print(f"Turborepo cache: removed {count} old objects, {size} bytes")
