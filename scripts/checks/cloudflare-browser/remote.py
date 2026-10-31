#!/usr/bin/env python3
"""Primary-only wrapper; uploads reviewed source, never browser binaries or credentials on disk."""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
RECORD = ROOT / 'docs/checks/autonomous-delivery/cloudflare-browser/workspace-creation.json'
WORKSPACE = '6bc1ff4f-c190-4d8f-becd-b7b3e01e9535'
DIRECTORY = '/tmp/hive-cloudflare-browser-ld5o18ur'
REMOTE = r'''
import json,os,pathlib,subprocess,sys
v=json.load(sys.stdin);p=pathlib.Path('/tmp/hive-cloudflare-browser-ld5o18ur')
s=p.lstat();assert p.resolve()==p and s.st_uid==os.getuid() and s.st_mode&0o077==0
assert os.environ.get('HIVE_WORKSPACE_PROFILE')=='browser'
assert json.loads((p/'node_modules/playwright/package.json').read_text())['version']=='1.61.1'
assert set(v['files'])=={'browser.mjs','policy.mjs','policy.test.mjs','driver-lifecycle.mjs','diagnostics.mjs'}
for name,data in v['files'].items():
 f=p/name
 if f.exists():assert not f.is_symlink() and f.stat().st_uid==os.getuid()
 f.write_text(data);f.chmod(0o600)
if v['mode']=='prepare':
 for args in [['node','--check','browser.mjs'],['node','--test','policy.test.mjs']]:
  r=subprocess.run(args,cwd=p,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
  assert r.returncode==0
 # Installed Chrome smoke check opens only about:blank and makes no application requests.
 code="import {chromium} from 'playwright';const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync']});console.log(JSON.stringify({chrome:b.version()}));await b.close();"
 r=subprocess.run(['node','--input-type=module','-e',code],cwd=p,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=25)
 assert r.returncode==0
 print(json.dumps({'prepared':True,'directory':str(p),'browser':json.loads(r.stdout),'package':json.loads((p/'package.json').read_text()),'lock':json.loads((p/'package-lock.json').read_text())}))
else:
 r=subprocess.run(['node','browser.mjs'],input=json.dumps(v['auth']),cwd=p,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=190)
 assert r.returncode==0
 result=json.loads(r.stdout);assert result['schemaVersion']==1
 print(json.dumps(result))
'''

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare', 'run'])
    parser.add_argument('--auth-file')
    args = parser.parse_args()
    assert os.environ.get('HIVE_WORKSPACE_PROFILE') == 'software'
    record = json.loads(RECORD.read_text())
    assert record['workspaceId'] == WORKSPACE
    env = dict(os.environ, CODER_URL=record['deployment'])
    listing = subprocess.run(['coder', 'list', '--output', 'json'], env=env, capture_output=True, text=True, check=True)
    matches = [w for w in json.loads(listing.stdout) if w['id'] == WORKSPACE]
    assert len(matches) == 1
    workspace = matches[0]
    for field, key in [('owner_id', 'ownerId'), ('template_id', 'templateId'), ('created_at', 'createdAt'), ('name', 'name')]:
        assert workspace[field] == record[key]
    assert workspace['latest_build']['status'] == 'running'
    files = {name: (SOURCE/name).read_text() for name in ['browser.mjs', 'policy.mjs', 'policy.test.mjs', 'driver-lifecycle.mjs', 'diagnostics.mjs']}
    payload = {'mode': args.mode, 'files': files}
    if args.mode == 'run':
        assert args.auth_file
        path = Path(args.auth_file)
        metadata = path.lstat()
        assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid() and metadata.st_mode & 0o077 == 0 and metadata.st_size <= 8192
        payload['auth'] = json.loads(path.read_text())
    else:
        assert args.auth_file is None
    # Script code only goes in argv. All task data/credentials use encrypted SSH stdin.
    import shlex
    command = 'python3 -I -c ' + shlex.quote(REMOTE)
    result = subprocess.run(['coder', 'ssh', '--disable-autostart', record['name'], '--', command], env=env, input=json.dumps(payload), capture_output=True, text=True, timeout=200)
    if result.returncode != 0:
        raise RuntimeError('remote_browser_check_failed_without_sensitive_output')
    report = json.loads(result.stdout)
    if args.mode == 'prepare':
        for key, filename in [('package', 'package.json'), ('lock', 'package-lock.json')]:
            (SOURCE/filename).write_text(json.dumps(report.pop(key), indent=2)+'\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'browser_harness_failed_without_sensitive_output'}))
        sys.exit(1)
