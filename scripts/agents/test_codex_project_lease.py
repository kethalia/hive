import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[2] / 'templates/ai-dev-k8s/scripts/codex-project-lease.py'
SPEC = importlib.util.spec_from_file_location('project_lease', SOURCE)
lease = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lease)


def write_signed(directory, name, key_name, state):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    key_path = directory / key_name
    if not key_path.exists():
        key_path.write_bytes(os.urandom(32))
        key_path.chmod(0o600)
    signature = hmac.new(key_path.read_bytes(), json.dumps(state, separators=(',', ':'), ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
    path = directory / name
    path.write_text(json.dumps({'state': state, 'signature': signature}, separators=(',', ':'), ensure_ascii=False))
    path.chmod(0o600)


class InstalledLeaseAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hive-lease-authority-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.child = subprocess.Popen(['/usr/bin/sleep', '60'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_child)
        self.project_id = str(uuid.uuid4())
        self.host = lease.process_identity(os.getpid())
        self.native = lease.process_identity(self.child.pid)
        self.expected = {'repositoryId': '123', 'taskId': 'task', 'leaseId': 'lease', 'leaseGeneration': 2, 'revision': 'a' * 40, 'checkoutIncarnation': 'incarnation'}
        task = {'taskId': 'task', 'phase': 'running', 'nativeThreadId': 'thread', 'nativeServerInstanceId': 'server', 'checkoutIncarnation': 'incarnation', 'request': {'revision': 'a' * 40}, 'prepared': {'leaseId': 'lease', 'leaseGeneration': 2, 'repositoryId': '123', 'taskId': 'task'}}
        self.controller = {'hostProcess': self.host, 'ownerId': 'owner', 'workspaceId': 'workspace', 'projects': {self.project_id: {'repositoryId': '123', 'task': task}}}
        self.supervisor = {'hostProcess': self.host, 'nativeProcess': self.native, 'ownerId': 'owner', 'workspaceId': 'workspace', 'serverInstanceId': 'server', 'status': 'ready', 'projects': {self.project_id: {'repositoryId': '123', 'threadId': 'thread', 'serverInstanceId': 'server', 'phase': 'persisted'}}}
        self.authority = lease.InstalledControllerAuthority(self.home, os.getpid())
        self.save()

    def stop_child(self):
        if self.child.poll() is None:
            self.child.terminate()
        self.child.wait(timeout=3)

    def save(self):
        write_signed(self.home / '.local/state/hive/codex-project-controller', 'projects.json', 'projects.key', self.controller)
        write_signed(self.home / '.local/state/hive/codex-project-supervisor', 'registry.json', 'key', self.supervisor)

    def test_real_kernel_parent_native_identity_and_journal_binding_authorize_only_exact_context(self):
        self.authority.verify(self.project_id, self.expected)
        for key, value in [('leaseId', 'other'), ('leaseGeneration', 3), ('taskId', 'other'), ('checkoutIncarnation', 'other'), ('revision', 'b' * 40)]:
            with self.subTest(key=key), self.assertRaisesRegex(lease.managed.ManagedError, 'renewal_binding_changed'):
                self.authority.verify(self.project_id, {**self.expected, key: value})

    def test_wrong_parent_start_time_executable_or_dead_native_cannot_renew(self):
        with self.assertRaises(Exception):
            lease.InstalledControllerAuthority(self.home, self.child.pid).verify(self.project_id, self.expected)
        for field, value in [('startTime', '0'), ('executable', '/untrusted'), ('inode', '0'), ('bootId', str(uuid.uuid4()))]:
            self.supervisor['nativeProcess'] = {**self.native, field: value}
            self.save()
            with self.subTest(field=field), self.assertRaisesRegex(lease.managed.ManagedError, 'native_process_changed'):
                self.authority.verify(self.project_id, self.expected)
        self.supervisor['nativeProcess'] = self.host
        self.save()
        with self.assertRaisesRegex(lease.managed.ManagedError, 'native_parent_changed'):
            self.authority.verify(self.project_id, self.expected)
        self.supervisor['nativeProcess'] = self.native
        self.save()
        self.stop_child()
        with self.assertRaises(Exception):
            self.authority.verify(self.project_id, self.expected)

    def test_revoked_or_replaced_native_lifetime_and_forged_journal_fail_closed(self):
        entry = self.supervisor['projects'][self.project_id]
        entry['executionRevoked'] = {'reason': 'fixture'}
        self.save()
        with self.assertRaisesRegex(lease.managed.ManagedError, 'execution_authority_revoked'):
            self.authority.verify(self.project_id, self.expected)
        del entry['executionRevoked']
        self.supervisor['serverInstanceId'] = 'other'
        self.save()
        with self.assertRaisesRegex(lease.managed.ManagedError, 'execution_authority_revoked'):
            self.authority.verify(self.project_id, self.expected)
        path = self.home / '.local/state/hive/codex-project-controller/projects.json'
        value = json.loads(path.read_text())
        value['state']['ownerId'] = 'forged'
        path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            self.authority.verify(self.project_id, self.expected)


if __name__ == '__main__':
    unittest.main()
