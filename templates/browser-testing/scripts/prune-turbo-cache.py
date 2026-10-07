"""Remove old, untracked Turborepo archives; preserve metadata and project outputs."""
import json
import os
import tempfile
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


ARCHIVE = re.compile(r"[0-9a-f]{16}\.tar\.zst")


GENERATED_DIRECTORIES = {
    ".git", "node_modules", ".next", ".venv", "venv", "__pycache__",
    "target", "Library", "Temp", "obj", "build", "dist",
}


def discovery(projects, state):
    # Persist a breadth-first frontier instead of restarting at the first tree.
    pending = state.setdefault("pending", [])
    if not pending:
        pending.append(".")
    while pending:
        relative = pending[0]
        directory = projects / relative
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            pending.pop(0)
            continue
        if any(parent.is_symlink() for parent in [directory, *directory.parents]):
            pending.pop(0)
            continue
        found = next(os.walk(directory, followlinks=False), None)
        if found is None:
            pending.pop(0)
            continue
        _, children, files = found
        children[:] = [name for name in children
                       if (directory == projects or name not in GENERATED_DIRECTORIES)
                       and not (directory / name).is_symlink()]
        yield str(directory), children, files
        # Advance only after the caller has completed this directory. If it
        # exhausts a budget, this item stays at the front for the next run.
        pending.pop(0)
        pending.extend(str((directory / name).relative_to(projects))
                       for name in children if name != ".turbo")


def scheduled_prune(projects, state_path):
    state_path = Path(state_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    if any(p.is_symlink() for p in [state_path, *state_path.parents]):
        raise OSError("Refusing a symlinked maintenance state path")
    try:
        state = json.loads(state_path.read_text())
        if (not isinstance(state, dict)
                or not isinstance(state.get("pending", []), list)
                or not all(isinstance(p, str) for p in state.get("pending", []))
                or not isinstance(state.get("offsets", {}), dict)
                or not all(isinstance(k, str) and type(v) is int and v >= 0
                           for k, v in state.get("offsets", {}).items())):
            raise ValueError("Invalid maintenance state")
    except (FileNotFoundError, ValueError):
        state = {}
    try:
        return prune(projects, apply=True, state=state)
    finally:
        # Atomic replacement keeps an interrupted checkpoint readable.
        with tempfile.NamedTemporaryFile(mode="w", dir=state_path.parent, delete=False) as out:
            temporary = Path(out.name)
            json.dump(state, out)
        try:
            os.replace(temporary, state_path)
        finally:
            temporary.unlink(missing_ok=True)


def prune(projects, now=None, maximum=2000, apply=False,
          max_directories=5000, time_budget=120, max_cache_entries=50000, state=None):
    projects = Path(projects)
    state = {} if state is None else state
    offsets = state.setdefault("offsets", {})
    now = time.time() if now is None else now
    deadline = time.monotonic() + time_budget
    removed = size = scanned = 0
    if projects.is_symlink() or not projects.is_dir():
        return removed, size
    for visited, (directory, children, _) in enumerate(
            discovery(projects, state)):
        if visited >= max_directories or time.monotonic() >= deadline:
            print("Cache discovery budget reached; continuing other maintenance", file=sys.stderr)
            return removed, size
        children[:] = [n for n in children
                       if (Path(directory) == projects or n not in GENERATED_DIRECTORIES)
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
            # Stream entries: memory stays constant even for a huge directory.
            # Count sidecars and unrelated files too, not just eligible archives.
            key = str(cache.relative_to(projects))
            position = 0
            resume = offsets.get(key, 0)
            with os.scandir(fd) as entries:
                # Replay the directory stream to its saved position without
                # charging already inspected entries against the work budget.
                # The time limit still applies, including during replay.
                while position < resume:
                    if time.monotonic() >= deadline:
                        return removed, size
                    if next(entries, None) is None:
                        offsets.pop(key, None)
                        break
                    position += 1
                while True:
                    if (time.monotonic() >= deadline or removed >= maximum
                            or scanned >= max_cache_entries):
                        return removed, size
                    entry = next(entries, None)
                    if entry is None:
                        offsets.pop(key, None)
                        break
                    position += 1
                    offsets[key] = position
                    scanned += 1
                    archive = entry.name
                    if not ARCHIVE.fullmatch(archive):
                        continue
                    try:
                        before = {archive: os.stat(archive, dir_fd=fd, follow_symlinks=False)}
                        # Only inspect this archive's two possible sidecars.
                        # Metadata is never modified or removed.
                        for suffix in ["-meta.json", "-manifest.json"]:
                            name = archive[:16] + suffix
                            try:
                                before[name] = os.stat(name, dir_fd=fd, follow_symlinks=False)
                            except FileNotFoundError:
                                pass
                        if any(not stat.S_ISREG(s.st_mode) or now - s.st_mtime <= 7 * 86400
                               for s in before.values()):
                            continue
                        current = {name: os.stat(name, dir_fd=fd, follow_symlinks=False)
                                   for name in before}
                        if any((s.st_ino, s.st_mtime_ns, s.st_size) != (
                                current[name].st_ino, current[name].st_mtime_ns,
                                current[name].st_size) for name, s in before.items()):
                            continue
                        if apply:
                            os.unlink(archive, dir_fd=fd)
                        removed += 1
                        size += before[archive].st_size
                    except OSError as error:
                        print(f"Skipping cache entry in {cache}: {error}", file=sys.stderr)
                        continue
        except OSError as error:
            print(f"Skipping unreadable cache {cache}: {error}", file=sys.stderr)
        finally:
            os.close(fd)
    return removed, size


if __name__ == "__main__":
    try:
        count, size = scheduled_prune(
            Path.home() / "projects",
            Path.home() / ".cache/hive/turbo-prune-state.json")
        print(f"Turborepo cache: removed {count} old objects, {size} bytes")
    except OSError as error:
        print(f"Skipping cache maintenance: checkpoint unavailable: {error}", file=sys.stderr)
