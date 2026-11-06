"""Actual private FD3 subprocess. Stops before any credential/provider request."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import unittest
import uuid

SPEC = importlib.util.spec_from_file_location("hive_worker_fixture", Path(__file__).with_name("test_delivery_source_runtime.py"))
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)
WORKER = FIXTURE.SOURCE.with_name("delivery-source-worker.py")


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = FIXTURE.ProtectedBrokerTests("runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.config = {"root": str(f.private), "workspace": str(f.workspace), "scope": f.scope,
                       "policy": f.policy, "metadataIdentity": {k: {n: str(v) for n, v in pair.items()} for k, pair in f.identity.items()},
                       "attemptLeaseGeneration": 3, "request": {**f.request, "operationId": str(uuid.uuid4())}}
        self.parent, child = socket.socketpair()
        self.parent.settimeout(10)
        child_fd = child.fileno()
        def inherited_fd():
            os.dup2(child_fd, 3)
            if child_fd != 3:
                os.close(child_fd)
        self.process = subprocess.Popen(["/usr/bin/python3", "-I", "-B", str(WORKER)],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        pass_fds=tuple({3, child_fd}), preexec_fn=inherited_fd, start_new_session=True,
                                        env={"PATH": "/usr/bin:/bin", "HOME": f.temp.name})
        child.close()
        self.buffer = bytearray()
        self.addCleanup(self.close)

    def close(self):
        self.parent.close()
        if self.process.poll() is None:
            self.process.kill()
        self.process.communicate(timeout=5)

    def send(self, value):
        self.parent.sendall(json.dumps(value).encode() + b"\n")

    def read(self):
        while b"\n" not in self.buffer:
            part = self.parent.recv(65536)
            self.assertTrue(part)
            self.buffer.extend(part)
        line, _, rest = self.buffer.partition(b"\n")
        self.buffer = bytearray(rest)
        return json.loads(line)

    def start(self):
        self.send({"schemaVersion": 1, "type": "start", "value": self.config})

    def prepared(self):
        self.start()
        previous, authorizations = 0, 0
        while True:
            frame = self.read()
            self.assertGreater(frame["id"], previous)
            previous = frame["id"]
            if frame["type"] == "prepared":
                self.assertGreater(authorizations, 3)
                return frame
            self.assertEqual(frame["type"], "authorize")
            self.assertEqual(frame["value"], {"action": "metadata"})
            authorizations += 1
            self.send({"schemaVersion": 1, "type": "response", "id": frame["id"], "value": self.config["metadataIdentity"]})

    def assert_failed(self):
        self.assertEqual(self.read()["value"], {"code": "source_worker_failed"})
        stdout, stderr = self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, 1)
        self.assertEqual((stdout, stderr), (b"", b""))

    def test_actual_worker_prepares_then_rejects_invalid_grant_without_credentials(self):
        frame = self.prepared()
        receipt, material = frame["value"]["receipt"], frame["value"]["challenge"]
        self.assertEqual(receipt["phase"], "prepared")
        self.assertFalse(receipt["fixtureOnly"])
        self.assertFalse(receipt["freshAcceptanceAuthority"])
        self.assertEqual(material["target"]["headSha"], receipt["commitSha"])
        self.send({"schemaVersion": 1, "type": "grant", "id": frame["id"], "value": {}})
        self.assert_failed()
        self.assertEqual(self.fixture.b.load(self.config["request"]["operationId"])["phase"], "prepared")

    def test_wrong_callback_reply_id_fails_closed(self):
        self.start()
        frame = self.read()
        self.assertEqual(frame["type"], "authorize")
        self.send({"schemaVersion": 1, "type": "response", "id": frame["id"] + 1, "value": self.config["metadataIdentity"]})
        self.assert_failed()
        self.assertFalse(self.fixture.b.operation_path(self.config["request"]["operationId"]).exists())

    def test_metadata_replacement_fails_before_parent_import(self):
        self.start()
        frame = self.read()
        changed = json.loads(json.dumps(self.config["metadataIdentity"]))
        changed["git"]["inode"] = str(int(changed["git"]["inode"]) + 1)
        self.send({"schemaVersion": 1, "type": "response", "id": frame["id"], "value": changed})
        self.assert_failed()

    def test_parent_eof_retains_prepared_journal_without_effect(self):
        self.prepared()
        self.parent.close()
        stdout, stderr = self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, 1)
        self.assertEqual((stdout, stderr), (b"", b""))
        self.assertEqual(self.fixture.b.load(self.config["request"]["operationId"])["phase"], "prepared")

    def test_restart_after_provider_publish_recovers_same_material_before_any_new_grant(self):
        self.assertEqual(self.fixture.publish()["phase"], "published")
        self.config["request"] = self.fixture.request
        path = self.fixture.b.operation_path(self.fixture.request["operationId"])
        saved = path.read_bytes()
        frame = self.prepared()
        self.assertEqual(frame["value"]["receipt"]["phase"], "published")
        self.assertEqual(frame["value"]["challenge"]["target"], self.fixture.grant["target"])
        self.parent.close()  # No final parent wire/grant supplied: retain, do not retry effects.
        stdout, stderr = self.process.communicate(timeout=5)
        self.assertEqual((self.process.returncode, stdout, stderr), (1, b"", b""))
        self.assertEqual(path.read_bytes(), saved)

    def test_duplicate_json_keys_are_rejected(self):
        self.parent.sendall(b'{"schemaVersion":1,"type":"start","type":"other","value":{}}\n')
        self.assert_failed()

    def test_no_fd3_or_command_line_activation(self):
        result = subprocess.run(["/usr/bin/python3", "-I", "-B", str(WORKER), "untrusted"],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=5,
                                env={"PATH": "/usr/bin:/bin", "HOME": self.fixture.temp.name})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, b"", b""))


if __name__ == "__main__":
    unittest.main()
