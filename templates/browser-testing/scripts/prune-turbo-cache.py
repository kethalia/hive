"""Remove old, untracked Turborepo archives; preserve metadata and project outputs."""
from contextlib import contextmanager
import ctypes
import errno
import json
import struct
from types import SimpleNamespace
import os
import tempfile
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid


ARCHIVE = re.compile(r"[0-9a-f]{16}\.tar(?:\.zst)?")


GENERATED_DIRECTORIES = {
    ".git", "node_modules", ".next", ".venv", "venv", "__pycache__",
    "target", "Library", "Temp", "obj", "build", "dist",
}


def retire_archive(fd, archive, expected):
    # Rename first: verifying an ordinary pathname before unlinking it leaves
    # a window in which a writer can replace that name with a fresh archive.
    quarantine = ".hive-prune-" + uuid.uuid4().hex
    os.mkdir(quarantine, mode=0o700, dir_fd=fd)
    held = None
    moved = removed = False
    try:
        held = os.open(quarantine, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.rename(archive, archive, src_dir_fd=fd, dst_dir_fd=held)
        moved = True
        actual = os.stat(archive, dir_fd=held, follow_symlinks=False)
        if (actual.st_dev, actual.st_ino, actual.st_mtime_ns, actual.st_size) != (
                expected.st_dev, expected.st_ino, expected.st_mtime_ns, expected.st_size):
            return False
        os.unlink(archive, dir_fd=held)
        removed = True
        return True
    finally:
        if moved and not removed:
            try:
                # link is no-clobber: never overwrite a newer archive that a
                # producer published while the candidate was quarantined.
                os.link(archive, archive, src_dir_fd=held, dst_dir_fd=fd,
                        follow_symlinks=False)
                os.unlink(archive, dir_fd=held)
            except OSError as error:
                print(f"Preserved cache candidate in {quarantine}/{archive}: {error}",
                      file=sys.stderr)
        if held is not None:
            os.close(held)
        try:
            os.rmdir(quarantine, dir_fd=fd)
        except OSError as error:
            if error.errno != errno.ENOTEMPTY:
                print(f"Could not remove empty quarantine {quarantine}: {error}", file=sys.stderr)


@contextmanager
def cache_entries(fd, cookie=0):
    # Linux/glibc workspace images only. d_off is an opaque filesystem cookie,
    # not an entry count: seek directly rather than replaying a growing prefix.
    # ABI: https://man7.org/linux/man-pages/man2/getdents.2.html
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        read_entries = libc.getdents64
    except AttributeError as error:
        raise OSError(errno.ENOSYS, "getdents64 unavailable") from error
    read_entries.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t]
    read_entries.restype = ctypes.c_ssize_t
    os.lseek(fd, cookie, os.SEEK_SET)

    def entries():
        buffer = ctypes.create_string_buffer(32768)
        while True:
            count = read_entries(fd, buffer, len(buffer))
            if count < 0:
                code = ctypes.get_errno()
                raise OSError(code, os.strerror(code))
            if count == 0:
                return
            raw = buffer.raw[:count]
            position = 0
            while position < count:
                if count - position < 20:
                    raise OSError(errno.EIO, "Truncated directory entry")
                _, next_cookie, length = struct.unpack_from("=QqH", raw, position)
                if length < 20 or position + length > count or next_cookie < 0:
                    raise OSError(errno.EIO, "Invalid directory entry")
                name = os.fsdecode(raw[position + 19:position + length].split(b"\0", 1)[0])
                position += length
                yield SimpleNamespace(name=name, cookie=next_cookie)

    yield entries()


def is_repository_root(parent_fd, name):
    # Both ordinary clones (.git directory) and linked/separate worktrees
    # (.git file) must survive generated-directory basename exclusions.
    try:
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=parent_fd)
        try:
            mode = os.stat(".git", dir_fd=child, follow_symlinks=False).st_mode
            return stat.S_ISDIR(mode) or stat.S_ISREG(mode)
        finally:
            os.close(child)
    except OSError:
        return False


def discovery(projects, state, deadline, max_directories=5000, max_entries=50000):
    # Depth-first streaming keeps only ancestors on the frontier. Each parent
    # resumes at its own cookie, without materializing its children or files.
    pending = state.setdefault("pending", [])
    cursors = state.setdefault("discovery_cursors", {})
    if not pending:
        pending.append(".")
    scanned = visited = 0
    while pending:
        if (time.monotonic() >= deadline or visited >= max_directories
                or scanned >= max_entries):
            return
        relative = pending[0]
        directory = projects / relative
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            pending.pop(0)
            cursors.pop(relative, None)
            continue
        fd = None
        try:
            fd = os.open(projects, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            for part in Path(relative).parts:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            visited += 1
            identity = os.fstat(fd)
            saved = cursors.get(relative, {})
            same = (saved.get("device"), saved.get("inode")) == (
                identity.st_dev, identity.st_ino)
            resume = saved.get("cookie", 0) if same else 0
            with cache_entries(fd, resume) as entries:
                while True:
                    if time.monotonic() >= deadline or scanned >= max_entries:
                        return
                    entry = next(entries, None)
                    if entry is None:
                        pending.pop(0)
                        cursors.pop(relative, None)
                        break
                    scanned += 1
                    checkpoint = {"device": identity.st_dev, "inode": identity.st_ino,
                                  "cookie": entry.cookie}
                    name = entry.name
                    if name in {".", ".."}:
                        cursors[relative] = checkpoint
                        continue
                    try:
                        is_directory = stat.S_ISDIR(os.stat(
                            name, dir_fd=fd, follow_symlinks=False).st_mode)
                    except OSError:
                        is_directory = False
                    if not is_directory:
                        cursors[relative] = checkpoint
                        continue
                    if name == ".turbo":
                        # Commit only after cache processing completes. A caller
                        # budget return leaves this entry pending for resumption.
                        yield str(directory), [".turbo"], []
                        cursors[relative] = checkpoint
                    elif (directory == projects or name not in GENERATED_DIRECTORIES
                          or is_repository_root(fd, name)):
                        cursors[relative] = checkpoint
                        pending.insert(0, str((directory / name).relative_to(projects)))
                        break
                    else:
                        cursors[relative] = checkpoint
        except OSError as error:
            print(f"Skipping discovery directory {directory}: {error}", file=sys.stderr)
            pending.pop(0)
            cursors.pop(relative, None)
        finally:
            if fd is not None:
                os.close(fd)


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
                or not all(isinstance(state.get(group, {}), dict)
                           and all(isinstance(k, str) and isinstance(v, dict)
                                   and all(type(v.get(field)) is int and v[field] >= 0
                                           for field in ["device", "inode", "cookie"])
                                   and v["cookie"] <= 2**63 - 1
                                   for k, v in state.get(group, {}).items())
                           for group in ["cursors", "discovery_cursors"])):
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
    state.pop("offsets", None)  # Discard entry-count checkpoints from older versions.
    cursors = state.setdefault("cursors", {})
    now = time.time() if now is None else now
    deadline = time.monotonic() + time_budget
    removed = size = scanned = 0
    if projects.is_symlink() or not projects.is_dir():
        return removed, size
    for visited, (directory, children, _) in enumerate(
            discovery(projects, state, deadline, max_directories, max_cache_entries)):
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
            identity = os.fstat(fd)
            saved = cursors.get(key, {})
            same_directory = (saved.get("device"), saved.get("inode")) == (
                identity.st_dev, identity.st_ino)
            resume = saved.get("cookie", 0) if same_directory else 0
            with cache_entries(fd, resume) as entries:
                while True:
                    if (time.monotonic() >= deadline or removed >= maximum
                            or scanned >= max_cache_entries):
                        return removed, size
                    entry = next(entries, None)
                    if entry is None:
                        cursors.pop(key, None)
                        break
                    cursors[key] = {"device": identity.st_dev, "inode": identity.st_ino,
                                    "cookie": entry.cookie}
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
                        if apply and not retire_archive(fd, archive, before[archive]):
                            continue
                        removed += 1
                        size += before[archive].st_size
                    except OSError as error:
                        print(f"Skipping cache entry in {cache}: {error}", file=sys.stderr)
                        continue
        except OSError as error:
            cursors.pop(str(cache.relative_to(projects)), None)
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
