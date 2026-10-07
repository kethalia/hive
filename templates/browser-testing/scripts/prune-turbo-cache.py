"""Remove only old, untracked Turborepo cache objects; never project outputs."""
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


OBJECT = re.compile(r"[0-9a-f]{16}(?:\.tar\.zst|-(?:meta|manifest)\.json)")


GENERATED_DIRECTORIES = {
    ".git", "node_modules", ".next", ".venv", "venv", "__pycache__",
    "target", "Library", "Temp", "obj", "build", "dist",
}


def prune(projects, now=None, maximum=2000, apply=False,
          max_directories=5000, time_budget=120):
    projects = Path(projects)
    now = time.time() if now is None else now
    deadline = time.monotonic() + time_budget
    removed = size = 0
    if projects.is_symlink() or not projects.is_dir():
        return removed, size
    for visited, (directory, children, _) in enumerate(
            os.walk(projects, followlinks=False)):
        if visited >= max_directories or time.monotonic() >= deadline:
            print("Cache discovery budget reached; continuing other maintenance", file=sys.stderr)
            return removed, size
        children[:] = [n for n in children if n not in GENERATED_DIRECTORIES
                       and not Path(directory, n).is_symlink()]
        if ".turbo" not in children:
            continue
        children.remove(".turbo")
        cache = Path(directory, ".turbo", "cache")
        if not cache.is_dir() or cache.is_symlink():
            continue
        try:
            tracked = subprocess.run(["git", "-C", directory, "ls-files", "--", ".turbo"],
                                     capture_output=True,
                                     timeout=max(0.001, min(10, deadline - time.monotonic())),
                                     check=False)
        except subprocess.TimeoutExpired:
            print(f"Skipping cache: Git probe timed out in {directory}", file=sys.stderr)
            continue
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
            groups = {}
            for name in sorted(os.listdir(fd)):
                if OBJECT.fullmatch(name):
                    groups.setdefault(name[:16], []).append(name)
            for names in groups.values():
                if time.monotonic() >= deadline:
                    return removed, size
                # Keep the file budget, but never split an archive from its
                # sidecars at the boundary. Remove the archive first so an
                # interrupted pass does not leave a hit with missing metadata.
                if removed + len(names) > maximum:
                    return removed, size
                names.sort(key=lambda name: (not name.endswith(".tar.zst"), name))
                try:
                    before = {name: os.stat(name, dir_fd=fd, follow_symlinks=False)
                              for name in names}
                    if any(not stat.S_ISREG(s.st_mode) or now - s.st_mtime <= 7 * 86400
                           for s in before.values()):
                        continue
                    current = {name: os.stat(name, dir_fd=fd, follow_symlinks=False)
                               for name in names}
                    if any((s.st_ino, s.st_mtime_ns, s.st_size) != (
                            current[name].st_ino, current[name].st_mtime_ns,
                            current[name].st_size) for name, s in before.items()):
                        continue
                    for name in names:
                        if apply:
                            os.unlink(name, dir_fd=fd)
                        removed += 1
                        size += before[name].st_size
                except FileNotFoundError:
                    continue  # A build or another maintenance pass won the race.
        finally:
            os.close(fd)
    return removed, size


if __name__ == "__main__":
    count, size = prune(Path.home() / "projects", apply=True)
    print(f"Turborepo cache: removed {count} old objects, {size} bytes")
