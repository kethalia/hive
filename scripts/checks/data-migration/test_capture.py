import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import sys
import unittest
import uuid

spec = importlib.util.spec_from_file_location("capture", Path(__file__).with_name("capture.py"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureContracts(unittest.TestCase):
    def test_connection_file_permissions_and_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connection"
            path.write_text("postgresql://test:secret@localhost/example?schema=public&sslmode=disable")
            path.chmod(0o600)
            self.assertNotIn("schema=", capture.connection(path))
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                capture.connection(path)
            path.chmod(0o600)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                capture.connection(link)
            for query in ["schema=other", "schema=public&schema=public", "options=-c+role=other"]:
                path.write_text("postgresql://localhost/example?" + query)
                with self.assertRaises(ValueError):
                    capture.connection(path)

    def test_fingerprint_preserves_duplicates_and_boundaries(self):
        class Rows:
            def rows(self, _sql):
                yield '{"x":"a"}'
                yield '{"x":"a"}'
        table = {"name": 'quoted"name', "columns": ["x"]}
        result = capture.fingerprint(Rows(), [table], 2)
        self.assertEqual(result[table["name"]]["count"], 2)
        with self.assertRaises(ValueError):
            capture.fingerprint(Rows(), [table], 1)

    def test_dump_enforces_cap_and_deadline_on_real_child(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "source.dump"
            fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with self.assertRaises(ValueError):
                    capture.dump_to_fd({}, "", fd, 32, time.monotonic() + 5,
                                       [sys.executable, "-c", "import sys;sys.stdout.write('x'*10000)"])
                self.assertLessEqual(archive.stat().st_size, 32)
                with self.assertRaises(ValueError):
                    capture.dump_to_fd({}, "", fd, 32, time.monotonic() + 0.15,
                                       [sys.executable, "-c", "import time;time.sleep(10)"])
            finally:
                os.close(fd)
            self.assertFalse((Path(directory) / "capture.json").exists())


@unittest.skipUnless(os.environ.get("HIVE_CAPTURE_TEST_PORT"), "isolated local PostgreSQL opt-in")
class CapturePostgres(unittest.TestCase):
    def test_consistent_snapshot_survives_concurrent_source_write_and_restores(self):
        port = os.environ["HIVE_CAPTURE_TEST_PORT"]
        self.assertTrue(port.isdigit() and 1024 <= int(port) <= 65535)
        suffix = uuid.uuid4().hex
        names = ["hive_capture_" + suffix, "hive_restore_" + suffix]
        urls = [f"postgresql://coder@127.0.0.1:{port}/{name}" for name in names]
        def sql(url, text):
            env = {**capture.environment(url)}
            env.pop("PGOPTIONS")
            return subprocess.check_output(["/usr/bin/psql", "-XqAt", "-v", "ON_ERROR_STOP=1"],
                                           input=text, text=True, env=env, stderr=subprocess.DEVNULL)
        created = []
        try:
            for name in names:
                subprocess.run(["/usr/bin/createdb", "-h", "127.0.0.1", "-p", port, "-U", "coder", name], check=True)
                created.append(name)
            sql(urls[0], '''CREATE TABLE sample(id integer, value text);
              INSERT INTO sample VALUES(1,E'line\\nquote"'),(2,NULL),(2,NULL);
              CREATE TABLE empty_table(id integer);''')
            with tempfile.TemporaryDirectory(prefix="hive-capture-proof-") as directory:
                root = Path(directory)
                credential = root / "connection"
                credential.write_text(urls[0])
                credential.chmod(0o600)
                original = capture.fingerprint
                def fingerprint_then_change(snapshot, tables, bound):
                    result = original(snapshot, tables, bound)
                    sql(urls[0], "INSERT INTO sample VALUES(99,'after snapshot');")
                    return result
                capture.fingerprint = fingerprint_then_change
                try:
                    result = capture.capture(credential, root / "captured", 10 * 1024 ** 2, 100, 30)
                finally:
                    capture.fingerprint = original
                self.assertEqual(result["rows"], 3)
                self.assertTrue(json.loads((root / "captured/capture.json").read_text())["tableRowsSameSnapshot"])
                self.assertEqual(sql(urls[0], "SELECT count(*) FROM sample;").strip(), "4")
                manifest = json.loads((root / "captured/capture.json").read_text())
                archive = root / "captured/source.dump"
                self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
                env = capture.environment(urls[1])
                env.pop("PGOPTIONS")
                # Only this test's freshly created, empty disposable database.
                sql(urls[1], "DROP SCHEMA public;")
                restored = subprocess.run(["/usr/bin/pg_restore", "--dbname=" + names[1], "--exit-on-error",
                                "--no-owner", "--no-acl", str(archive)],
                               env={**env, "PGHOST": "127.0.0.1", "PGPORT": port, "PGUSER": "coder"},
                               capture_output=True, text=True)
                self.assertEqual(restored.returncode, 0, restored.stderr)
                target = capture.Snapshot(capture.environment(urls[1]), 30)
                try:
                    tables = [{"name": name, "columns": value["columns"]} for name, value in manifest["tables"].items()]
                    self.assertEqual(capture.fingerprint(target, tables, 100), manifest["tables"])
                finally:
                    target.close()
                with self.assertRaises(ValueError):
                    capture.capture(credential, root / "too-many", 10 * 1024 ** 2, 1, 30)
                self.assertFalse((root / "too-many/capture.json").exists())
                # Exercise failure propagation through the complete capture path.
                original_dump = capture.dump_to_fd
                for name, code in [("capped", "import sys;sys.stdout.buffer.write(b'x'*11000000)"),
                                   ("stalled", "import time;time.sleep(10)")]:
                    def failing_dump(env, exported, fd, maximum, deadline, script=code):
                        return original_dump(env, exported, fd, maximum,
                                             min(deadline, time.monotonic() + 0.3) if name == "stalled" else deadline,
                                             [sys.executable, "-c", script])
                    capture.dump_to_fd = failing_dump
                    try:
                        with self.assertRaises(ValueError):
                            capture.capture(credential, root / name, 10 * 1024 ** 2, 100, 30)
                    finally:
                        capture.dump_to_fd = original_dump
                    self.assertFalse((root / name / "capture.json").exists())
                    self.assertLessEqual((root / name / "source.dump").stat().st_size, 10 * 1024 ** 2)
                # A replaced output path cannot redirect the pinned directory writes or publish success.
                original_dump = capture.dump_to_fd
                def replace_directory(*args, **kwargs):
                    value = original_dump(*args, **kwargs)
                    (root / "redirected").mkdir()
                    (root / "swap").rename(root / "moved")
                    (root / "swap").symlink_to(root / "redirected", target_is_directory=True)
                    return value
                capture.dump_to_fd = replace_directory
                try:
                    with self.assertRaises(ValueError):
                        capture.capture(credential, root / "swap", 10 * 1024 ** 2, 100, 30)
                finally:
                    capture.dump_to_fd = original_dump
                self.assertFalse((root / "redirected/capture.json").exists())
                self.assertFalse((root / "moved/capture.json").exists())
                with self.assertRaises(FileExistsError):
                    capture.capture(credential, root / "captured", 10 * 1024 ** 2, 100, 30)
        finally:
            for name in reversed(created):
                subprocess.run(["/usr/bin/dropdb", "-h", "127.0.0.1", "-p", port, "-U", "coder", name], check=True)


if __name__ == "__main__":
    unittest.main()
