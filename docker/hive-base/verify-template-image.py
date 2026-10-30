#!/usr/bin/env python3
"""Verify public bootstrap bytes and filesystem ownership in an already-built image."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

FILES = {
    'codex-host.tar.xz': 'templates/ai-dev-k8s/assets/codex-host.tar.xz',
    'workspace-read.tar.gz': 'templates/ai-dev-k8s/assets/workspace-read.tar.gz',
    'voice.tar.gz': 'templates/ai-dev-k8s/assets/voice.tar.gz',
    'agent-bridge.tar.gz': 'templates/ai-dev-k8s/assets/agent-bridge.tar.gz',
    'install-codex-host.py': 'templates/ai-dev-k8s/scripts/install-codex-host.py',
    'install-workspace-read.py': 'templates/ai-dev-k8s/scripts/install-workspace-read.py',
    'install-voice.py': 'templates/ai-dev-k8s/scripts/install-voice.py',
    'install-agent-bridge.py': 'templates/ai-dev-k8s/scripts/install-agent-bridge.py',
    'hive-template-bootstrap': 'docker/hive-base/hive-template-bootstrap.py',
}
INSPECT = r'''import hashlib,json,stat,sys
from pathlib import Path
root=Path('/usr/local/libexec/hive-template-runtime')
files=['codex-host.tar.xz','workspace-read.tar.gz','voice.tar.gz','agent-bridge.tar.gz','install-codex-host.py','install-workspace-read.py','install-voice.py','install-agent-bridge.py']
def fail(code,p,s=None):
 out={'ok':False,'code':code,'path':str(p)}
 if s is not None: out.update(uid=s.st_uid,mode=oct(stat.S_IMODE(s.st_mode)),nlink=s.st_nlink,size=s.st_size)
 print(json.dumps(out,sort_keys=True,separators=(',',':')))
 sys.exit(0)
out={}
for p in [Path('/usr'),Path('/usr/local'),Path('/usr/local/libexec'),root]:
 try: s=p.lstat()
 except OSError: fail('directory_unavailable',p)
 if p.resolve()!=p or not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode & 0o022 or s.st_mode & 0o111 != 0o111: fail('directory_rejected',p,s)
for name in files+['hive-template-bootstrap']:
 p=(Path('/usr/local/libexec') if name=='hive-template-bootstrap' else root)/name
 try: s=p.lstat()
 except OSError: fail('file_unavailable',p)
 if p.resolve()!=p or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode & 0o022 or not 0<s.st_size<=524288: fail('file_rejected',p,s)
 try: out[name]=hashlib.sha256(p.read_bytes()).hexdigest()
 except OSError: fail('file_unreadable',p,s)
print(json.dumps({'ok':True,'files':out},sort_keys=True,separators=(',',':')))
'''

class SmokeFailure(Exception):
    def __init__(self, code, **details):
        super().__init__(code)
        self.details = {'code': code, **details}


def verify(image, run=subprocess.run):
    if not isinstance(image, str) or not image or len(image) > 512 or image.startswith('-'):
        raise SmokeFailure('image_rejected')
    try:
        result = run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', '/usr/bin/python3', image, '-I', '-B', '-c', INSPECT], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SmokeFailure('docker_unavailable') from None
    if result.returncode != 0: raise SmokeFailure('docker_run_failed', exitCode=result.returncode)
    if len(result.stdout) > 8192: raise SmokeFailure('proof_too_large')
    try: observed = json.loads(result.stdout)
    except (ValueError, UnicodeError): raise SmokeFailure('invalid_proof') from None
    if not isinstance(observed, dict) or not isinstance(observed.get('ok'), bool): raise SmokeFailure('invalid_proof')
    if not observed['ok']:
        # Accept only values emitted by the fixed inspector, never arbitrary output.
        allowed = {'directory_unavailable', 'directory_rejected', 'file_unavailable', 'file_rejected', 'file_unreadable'}
        safe_paths = {'/usr', '/usr/local', '/usr/local/libexec', '/usr/local/libexec/hive-template-runtime', '/usr/local/libexec/hive-template-bootstrap'} | {'/usr/local/libexec/hive-template-runtime/' + name for name in FILES if name != 'hive-template-bootstrap'}
        if observed.get('code') not in allowed or observed.get('path') not in safe_paths: raise SmokeFailure('invalid_proof')
        details = {key: observed[key] for key in ('path', 'uid', 'mode', 'nlink', 'size') if key in observed and (isinstance(observed[key], int) or (key == 'path' and isinstance(observed[key], str)) or (key == 'mode' and isinstance(observed[key], str) and len(observed[key]) <= 8))}
        raise SmokeFailure(observed['code'], **details)
    if set(observed) != {'ok', 'files'} or not isinstance(observed['files'], dict) or set(observed['files']) != set(FILES): raise SmokeFailure('invalid_proof')
    try: expected = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in FILES.items()}
    except OSError: raise SmokeFailure('source_unavailable') from None
    for name in FILES:
        actual = observed['files'][name]
        if not isinstance(actual, str) or len(actual) != 64 or any(c not in '0123456789abcdef' for c in actual): raise SmokeFailure('invalid_proof')
        if actual != expected[name]: raise SmokeFailure('source_mismatch', file=name, expectedSha256=expected[name], observedSha256=actual)
    return {'schemaVersion': 1, 'rootOwned': True, 'nonWritable': True, 'files': observed['files']}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise SmokeFailure('image_required')
        print(json.dumps(verify(sys.argv[1]), sort_keys=True, separators=(',', ':')))
    except SmokeFailure as error:
        print('workspace_image_bootstrap_smoke_failed ' + json.dumps(error.details, sort_keys=True, separators=(',', ':')), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        print('workspace_image_bootstrap_smoke_failed {"code":"unexpected"}', file=sys.stderr)
        raise SystemExit(1) from None
