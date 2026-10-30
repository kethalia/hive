#!/usr/bin/env python3
"""Primary-only setup/run transport. Default prepare has no preview requests."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
RECORD = ROOT / "docs/checks/autonomous-delivery/project-preview-browser/workspace-creation.json"
PRIVATE = Path("/tmp/hive-epic-coder-auth")
PREPARATION = PRIVATE / "project-browser-preparation.json"
ATTEMPT = PRIVATE / "project-browser-live-attempt.json"
FILES = ["browser.mjs", "policy.mjs", "policy.test.mjs", "package.json", "package-lock.json"]
REMOTE = r'''
import json,os,pathlib,stat,subprocess,sys,tempfile
v=json.load(sys.stdin)
assert os.environ.get('HIVE_WORKSPACE_PROFILE')=='browser'
assert not os.environ.get('CODER_SESSION_TOKEN')
assert set(v['files'])=={'browser.mjs','policy.mjs','policy.test.mjs','package.json','package-lock.json'}
assert all(isinstance(x,str) for x in v['files'].values()) and sum(len(x) for x in v['files'].values())<1048576
if v['directory'] is None:
 assert v['mode']=='prepare'
 p=pathlib.Path(tempfile.mkdtemp(prefix='hive-project-preview-',dir='/tmp'))
else:
 p=pathlib.Path(v['directory'])
 assert p.parent==pathlib.Path('/tmp') and p.name.startswith('hive-project-preview-')
s=p.lstat();assert p.resolve()==p and s.st_uid==os.getuid() and stat.S_ISDIR(s.st_mode) and s.st_mode&0o077==0
for name,data in v['files'].items():
 f=p/name
 if f.exists():assert f.is_file() and not f.is_symlink() and f.stat().st_uid==os.getuid() and f.stat().st_nlink==1
 f.write_text(data);f.chmod(0o600)
assert json.loads((p/'package.json').read_text())['dependencies']=={'playwright':'1.61.1'}
if v['mode']=='prepare':
 if not (p/'node_modules/playwright/package.json').exists():
  env=dict(os.environ,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1')
  r=subprocess.run(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],env=env,cwd=p,capture_output=True,timeout=90)
  assert r.returncode==0
 assert json.loads((p/'node_modules/playwright/package.json').read_text())['version']=='1.61.1'
 for args in [['node','--check','browser.mjs'],['node','--test','policy.test.mjs']]:
  r=subprocess.run(args,cwd=p,capture_output=True,timeout=20);assert r.returncode==0
 code="import {chromium} from 'playwright';const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync']});try{const c=await b.newContext({serviceWorkers:'block'});await c.route('**/*',r=>r.abort());const p=await c.newPage();await p.setContent('<title>PRIVATE_SYNTHETIC_PREPARATION</title>');if(await p.title()!=='PRIVATE_SYNTHETIC_PREPARATION')throw Error();console.log(JSON.stringify({chrome:b.version(),syntheticOnly:true}));await c.close();}finally{await b.close();}"
 r=subprocess.run(['node','--input-type=module','-e',code],cwd=p,capture_output=True,text=True,timeout=25);assert r.returncode==0
 print(json.dumps({'schemaVersion':1,'prepared':True,'directory':str(p),'browser':json.loads(r.stdout),'playwright':'1.61.1','previewRequests':0,'ownerCredentialCopied':False}))
else:
 assert json.loads((p/'node_modules/playwright/package.json').read_text())['version']=='1.61.1'
 r=subprocess.run(['node','browser.mjs','--run'],input=json.dumps({'auth':v['auth'],'scope':v['scope']}),cwd=p,capture_output=True,text=True,timeout=190)
 try:
  result=json.loads(r.stdout);assert result['schemaVersion']==1 and result['phase']=='A' and type(result['passed']) is bool
 except Exception:result={'schemaVersion':1,'phase':'A','passed':False,'stage':'driver_failed_without_sensitive_output'}
 print(json.dumps(result))
'''


def private_json(path, maximum):
    path = Path(path)
    assert path.is_absolute() and path.resolve() == path
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        assert stat.S_ISREG(meta.st_mode) and meta.st_uid == os.getuid() and meta.st_nlink == 1 and not meta.st_mode & 0o077 and meta.st_size <= maximum
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw = stream.read(maximum + 1)
        assert len(raw) <= maximum
        return json.loads(raw)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", nargs="?", choices=["prepare", "run"], default="prepare")
    parser.add_argument("--auth-file")
    parser.add_argument("--scope-file")
    parser.add_argument("--approved-live", action="store_true")
    args = parser.parse_args()
    assert os.environ.get("HIVE_WORKSPACE_PROFILE") == "software"
    record = json.loads(RECORD.read_text())
    assert record["workspaceId"] == "5cf78a47-70dc-4781-ac53-b7a3d4b1001f" and record["task"] == "hive-project-session-preview"
    assert record["designation"] == "task-created-disposable" and record["deployment"] == "https://coder.kethalia.com"
    env = dict(os.environ, CODER_URL=record["deployment"])
    listing = subprocess.run(["coder", "list", "--output", "json"], env=env, capture_output=True, text=True, check=True, timeout=20)
    matches = [w for w in json.loads(listing.stdout) if w["id"] == record["workspaceId"]]
    assert len(matches) == 1
    workspace = matches[0]
    for remote, local in [("owner_id", "ownerId"), ("template_id", "templateId"), ("created_at", "createdAt"), ("name", "name")]:
        assert workspace[remote] == record[local]
    assert workspace["latest_build"]["status"] == "running"
    prepared = private_json(PREPARATION, 65536) if PREPARATION.exists() else None
    if prepared:
        assert prepared["workspaceId"] == record["workspaceId"] and prepared["buildId"] == workspace["latest_build"]["id"]
    files = {name: (SOURCE / name).read_text() for name in FILES}
    hashes = {name: hashlib.sha256(data.encode()).hexdigest() for name, data in files.items()}
    controller_digest = hashlib.sha256(REMOTE.encode()).hexdigest()
    payload = {"mode": args.mode, "files": files, "directory": prepared["directory"] if prepared else None}
    if args.mode == "run":
        assert prepared and args.approved_live and args.auth_file and args.scope_file
        assert hashes == prepared["sourceHashes"]
        assert controller_digest == prepared["controllerSha256"]
        payload["auth"] = private_json(args.auth_file, 8192)
        payload["scope"] = private_json(args.scope_file, 8192)
        # An interrupted/failed run may have spent an unknown budget. Never
        # automatically replace this receipt or reset its counters for a retry.
        fd = os.open(ATTEMPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump({"schemaVersion": 1, "status": "started_outcome_unknown", "workspaceId": record["workspaceId"], "buildId": workspace["latest_build"]["id"], "sourceHashes": hashes, "scopeSha256": hashlib.sha256(json.dumps(payload["scope"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        directory_fd = os.open(PRIVATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    else:
        assert not args.approved_live and args.auth_file is None and args.scope_file is None
    result = subprocess.run(["coder", "ssh", "--disable-autostart", record["name"], "--", "python3 -I -c " + shlex.quote(REMOTE)], env=env, input=json.dumps(payload), capture_output=True, text=True, timeout=200)
    assert result.returncode == 0, "remote_failed_without_sensitive_output"
    report = json.loads(result.stdout)
    report["sourceHashes"] = hashes
    report["controllerSha256"] = controller_digest
    report["workspaceId"] = record["workspaceId"]
    report["buildId"] = workspace["latest_build"]["id"]
    report["observedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    if args.mode == "prepare":
        PRIVATE.mkdir(mode=0o700, exist_ok=True)
        assert PRIVATE.resolve() == PRIVATE and PRIVATE.stat().st_uid == os.getuid() and not PRIVATE.stat().st_mode & 0o077
        # No credentials; preparation provenance only. Preserve an earlier file
        # unless this action already revalidated its exact workspace/build.
        flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_TRUNC if prepared else os.O_EXCL)
        fd = os.open(PREPARATION, flags, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(report, stream)
            stream.flush()
            os.fsync(stream.fileno())
    print(json.dumps(report, indent=2))
    if args.mode == "run" and not report.get("passed"):
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"schemaVersion": 1, "passed": False, "stage": "harness_failed_without_sensitive_output"}))
        sys.exit(1)
