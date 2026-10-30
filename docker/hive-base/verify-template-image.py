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
    'install-codex-host.py': 'templates/ai-dev-k8s/scripts/install-codex-host.py',
    'install-workspace-read.py': 'templates/ai-dev-k8s/scripts/install-workspace-read.py',
    'install-voice.py': 'templates/ai-dev-k8s/scripts/install-voice.py',
    'hive-template-bootstrap': 'docker/hive-base/hive-template-bootstrap.py',
}
INSPECT = r'''import hashlib,json,os,stat
from pathlib import Path
root=Path('/usr/local/libexec/hive-template-runtime')
files=['codex-host.tar.xz','workspace-read.tar.gz','voice.tar.gz','install-codex-host.py','install-workspace-read.py','install-voice.py']
for p in [Path('/usr'),Path('/usr/local'),Path('/usr/local/libexec'),root]:
 s=p.lstat()
 if p.resolve()!=p or not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode & 0o022: raise SystemExit(1)
out={}
for name in files+['hive-template-bootstrap']:
 p=(Path('/usr/local/libexec') if name=='hive-template-bootstrap' else root)/name
 s=p.lstat()
 if p.resolve()!=p or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode & 0o022 or not 0<s.st_size<=524288: raise SystemExit(1)
 out[name]=hashlib.sha256(p.read_bytes()).hexdigest()
print(json.dumps(out,sort_keys=True,separators=(',',':')))
'''

def verify(image, run=subprocess.run):
    if not isinstance(image, str) or not image or len(image) > 512 or image.startswith('-'):
        raise ValueError('image rejected')
    result = run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', '/usr/bin/python3', image, '-I', '-B', '-c', INSPECT], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
    if len(result.stdout) > 8192: raise ValueError('bootstrap proof too large')
    observed = json.loads(result.stdout)
    expected = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in FILES.items()}
    if observed != expected: raise ValueError('image bootstrap source mismatch')
    return {'schemaVersion': 1, 'rootOwned': True, 'nonWritable': True, 'files': observed}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise ValueError('image required')
        print(json.dumps(verify(sys.argv[1]), sort_keys=True, separators=(',', ':')))
    except Exception:
        print('workspace_image_bootstrap_smoke_failed', file=sys.stderr)
        raise SystemExit(1) from None
