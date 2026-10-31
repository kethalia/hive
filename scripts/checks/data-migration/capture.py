#!/usr/bin/env python3
"""Capture a private PostgreSQL rehearsal archive and same-snapshot row hashes.

No restore, schema mutation, network upload, or production cutover is performed.
Credentials and rows never enter the public result. The destination must be new.
Same-snapshot proof covers public ordinary-table rows; sequence values are not
MVCC-snapshotted and other schemas and large objects are outside this capture.
Relation sizes are estimates, not limits on database reads or sort temp space.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit


def require(condition):
    if not condition:
        raise ValueError("migration_capture_rejected")


def connection(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and info.st_nlink == 1 and not info.st_mode & 0o077 and info.st_size <= 8192)
        value = os.read(fd, 8193).decode().strip()
    finally:
        os.close(fd)
    url = urlsplit(value)
    require(url.scheme in ("postgres", "postgresql") and url.hostname and url.path
            and not url.fragment and not any(c in value for c in "\r\n\x00"))
    # Prisma's schema parameter is not a libpq parameter. This tool only captures public.
    query = parse_qsl(url.query, keep_blank_values=True)
    require(len(dict(query)) == len(query))
    allowed = {"sslmode", "sslrootcert", "channel_binding", "connect_timeout", "schema"}
    require(all(key in allowed for key, _ in query))
    require(all(value == "public" for key, value in query if key == "schema"))
    query = [(key, value) for key, value in query if key != "schema"]
    return urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), ""))


def environment(url):
    # Ignore inherited libpq options, service files and psql startup configuration.
    parsed = urlsplit(url)
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "PGHOST": parsed.hostname, "PGPORT": str(parsed.port or 5432),
            "PGDATABASE": unquote(parsed.path[1:]), "PGUSER": unquote(parsed.username or ""),
            "PGPASSWORD": unquote(parsed.password or ""), "PGPASSFILE": "/dev/null",
            "PGCONNECT_TIMEOUT": "10", "PGCLIENTENCODING": "UTF8",
            "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=30000 "
                         "-c lock_timeout=5000 -c timezone=UTC -c datestyle=ISO,MDY"}
    for key, value in parse_qsl(parsed.query):
        if key in ("sslmode", "sslrootcert", "channel_binding"):
            env[{"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT",
                 "channel_binding": "PGCHANNELBINDING"}[key]] = value
    return env


def identifier(value):
    require(isinstance(value, str) and "\x00" not in value and 0 < len(value.encode()) <= 63)
    return '"' + value.replace('"', '""') + '"'


def remaining(deadline):
    value = deadline - time.monotonic()
    require(value > 0)
    return value


class Snapshot:
    def __init__(self, env, timeout, deadline=None):
        self.deadline = deadline if deadline is not None else time.monotonic() + timeout
        remaining(self.deadline)
        self.process = subprocess.Popen(
            ["/usr/bin/psql", "-XqAt", "-v", "ON_ERROR_STOP=1"], env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1)
        def expire():
            try: self.process.kill()
            except ProcessLookupError: pass
        try:
            self.timer = threading.Timer(remaining(self.deadline), expire)
            self.timer.daemon = True
            self.timer.start()
        except BaseException:
            self.process.kill()
            self.process.wait(timeout=5)
            self.process.stdin.close()
            self.process.stdout.close()
            raise

    def rows(self, sql):
        remaining(self.deadline)
        marker = "HIVE_CAPTURE_END_" + uuid.uuid4().hex
        self.process.stdin.write(sql + "\nSELECT '" + marker + "';\n")
        self.process.stdin.flush()
        while True:
            remaining(self.deadline)
            line = self.process.stdout.readline(8 * 1024 * 1024 + 1)
            remaining(self.deadline)
            require(line != "")
            if line.rstrip("\n") == marker:
                break
            require(line.endswith("\n") and len(line.encode()) <= 8 * 1024 * 1024)
            yield line.rstrip("\n")

    def one(self, sql):
        rows = list(self.rows(sql))
        require(len(rows) == 1)
        return rows[0]

    def close(self):
        self.timer.cancel()
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()


def fingerprint(snapshot, tables, max_rows):
    result = {}
    total = 0
    for table in tables:
        name = table["name"]
        digest, count = hashlib.sha256(), 0
        sql = ('SELECT row_to_json(t)::text FROM ONLY public.' + identifier(name)
               + ' t ORDER BY row_to_json(t)::text COLLATE "C";')
        for row in snapshot.rows(sql):
            require(row.startswith("{"))
            encoded = row.encode()
            # Length framing preserves duplicate rows and prevents concatenation ambiguity.
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
            count += 1
            total += 1
            require(total <= max_rows)
        result[name] = {"count": count, "sha256": digest.hexdigest(), "columns": table["columns"]}
    return result


def dump_to_fd(env, snapshot, fd, max_bytes, deadline, command=None):
    """Bound output before writing; kill the child on every failure or timeout."""
    command = command or ["/usr/bin/pg_dump", "--format=custom", "--no-owner", "--no-acl",
                          "--schema=public", "--lock-wait-timeout=5s", "--snapshot=" + snapshot]
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    digest, total = hashlib.sha256(), 0
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while True:
            require(selector.select(remaining(deadline)))
            data = os.read(process.stdout.fileno(), min(65536, max_bytes - total + 1))
            if not data:
                break
            total += len(data)
            require(total <= max_bytes)
            digest.update(data)
            view = memoryview(data)
            while view:
                remaining(deadline)
                written = os.write(fd, view)
                require(written > 0)
                view = view[written:]
        require(process.wait(timeout=remaining(deadline)) == 0 and total > 0)
        remaining(deadline)
        return total, digest.hexdigest()
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()


def capture(connection_file, destination, max_bytes, max_rows, timeout):
    require(1 <= max_bytes <= 1024 ** 3 and 1 <= max_rows <= 1_000_000
            and 10 <= timeout <= 900)
    deadline = time.monotonic() + timeout
    env = environment(connection(connection_file))
    remaining(deadline)
    destination = Path(destination)
    destination.mkdir(mode=0o700)
    require(destination.resolve() == destination.absolute())
    dirfd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        directory_stat = os.fstat(dirfd)
        require(directory_stat.st_uid == os.getuid() and not directory_stat.st_mode & 0o077)
        def same_directory():
            current = os.stat(destination, follow_symlinks=False)
            require(stat.S_ISDIR(current.st_mode) and current.st_dev == directory_stat.st_dev
                    and current.st_ino == directory_stat.st_ino)
        snapshot = Snapshot(env, timeout, deadline)
        try:
            exported = snapshot.one("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();")
            require(re.fullmatch(r"[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+", exported))
            metadata = json.loads(snapshot.one("""SELECT json_build_object(
              'version',current_setting('server_version_num')::int,
              'readOnly',current_setting('transaction_read_only'),
              'unsupportedRelations',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relkind IN ('p','f','m')),
              'tables',COALESCE((SELECT json_agg(x ORDER BY name) FROM (
                SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes,
                  (SELECT json_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a
                   WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r') x),'[]'::json))::jsonb::text;"""))
            require(metadata["readOnly"] == "on" and metadata["unsupportedRelations"] == 0)
            require(0 < len(metadata["tables"]) <= 256)
            # Physical relation sizes are an estimate, not a bound on server reads or sort space.
            require(sum(t["bytes"] for t in metadata["tables"]) <= max_bytes)
            version = subprocess.check_output(["/usr/bin/pg_dump", "--version"], env=env,
                                              timeout=min(5, remaining(deadline)), text=True, stderr=subprocess.DEVNULL)
            require(int(re.search(r"PostgreSQL\) (\d+)", version)[1]) >= metadata["version"] // 10000)
            hashes = fingerprint(snapshot, metadata["tables"], max_rows)
            remaining(deadline)
            fd = os.open("source.dump", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=dirfd)
            try:
                size, digest = dump_to_fd(env, exported, fd, max_bytes, deadline)
            finally:
                os.close(fd)
            remaining(deadline)
            result = {"schemaVersion": 1, "sourceReadOnly": True, "tableRowsSameSnapshot": True,
                      "postgresVersion": metadata["version"], "archiveBytes": size,
                      "archiveSha256": digest, "tables": hashes,
                      "restored": False, "productionCutover": False}
            same_directory()
            remaining(deadline)
            fd = os.open("capture.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=dirfd)
            try:
                with os.fdopen(fd, "w") as output:
                    json.dump(result, output, indent=2)
                    output.write("\n")
            except BaseException:
                # A partial manifest cannot be mistaken for completed evidence.
                try: os.unlink("capture.json", dir_fd=dirfd)
                except OSError: pass
                raise
            try:
                remaining(deadline)
                same_directory()
            except BaseException:
                os.unlink("capture.json", dir_fd=dirfd)
                raise
            return {"captured": True, "tables": len(hashes), "rows": sum(t["count"] for t in hashes.values()),
                    "archiveBytes": size, "restored": False}
        finally:
            snapshot.close()
    finally:
        os.close(dirfd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection-file", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--max-source-bytes", type=int, default=100 * 1024 ** 2)
    parser.add_argument("--max-rows", type=int, default=100_000)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    args = parser.parse_args()
    try:
        print(json.dumps(capture(args.connection_file, args.destination, args.max_source_bytes,
                                 args.max_rows, args.timeout_seconds)))
    except Exception:
        # Keep partial private archives for diagnosis; never report successful capture.
        print("migration_capture_failed; no successful capture manifest was published", file=sys.stderr)
        raise SystemExit(1) from None
