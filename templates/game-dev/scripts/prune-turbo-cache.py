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
        fd = None
        try:
            fd = os.open(projects, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            for part in cache.relative_to(projects).parts:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
        except OSError as error:
            if fd is not None:
                os.close(fd)
            print(f"Skipping inaccessible cache {cache}: {error}", file=sys.stderr)
            continue
        try:
            groups = {}
            for name in sorted(os.listdir(fd)):
                if OBJECT.fullmatch(name):
                    groups.setdefault(name[:16], []).append(name)
            for names in groups.values():
                if time.monotonic() >= deadline:
                    return removed, size
                archive = names[0][:16] + ".tar.zst"
                retiring_archive = archive in names
                candidates = [archive] if retiring_archive else names
                # Archive retirement and orphan-sidecar collection are separate
                # passes. Never exhaust the file budget within either phase.
                if removed + len(candidates) > maximum:
                    return removed, size
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
                    if retiring_archive and apply:
                        # A reader can keep the unlinked archive open and only
                        # read metadata after restoring it. Start a fresh grace
                        # period BEFORE unlinking; interruption remains safe.
                        for name in names:
                            if name == archive:
                                continue
                            sidecar = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                            try:
                                actual = os.fstat(sidecar)
                                expected = before[name]
                                if (actual.st_ino, actual.st_mtime_ns, actual.st_size) != (
                                        expected.st_ino, expected.st_mtime_ns, expected.st_size):
                                    raise OSError("Sidecar changed during inspection")
                                os.utime(sidecar, (now, now))
                            finally:
                                os.close(sidecar)
                    if not retiring_archive:
                        try:
                            os.stat(archive, dir_fd=fd, follow_symlinks=False)
                        except FileNotFoundError:
                            pass
                        else:
                            continue  # A build recreated this cache entry.
                    for name in candidates:
                        if apply:
                            os.unlink(name, dir_fd=fd)
                        removed += 1
                        size += before[name].st_size
                except OSError as error:
                    print(f"Skipping cache entry in {cache}: {error}", file=sys.stderr)
                    continue
        except OSError as error:
            print(f"Skipping unreadable cache {cache}: {error}", file=sys.stderr)
        finally:
            os.close(fd)
    return removed, size


if __name__ == "__main__":
    count, size = prune(Path.home() / "projects", apply=True)
    print(f"Turborepo cache: removed {count} old objects, {size} bytes")
