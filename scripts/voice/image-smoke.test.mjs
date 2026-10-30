import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const driver = `import importlib.util,json,hashlib,sys,types
from pathlib import Path
spec=importlib.util.spec_from_file_location('smoke','docker/hive-base/verify-template-image.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
expected={name:hashlib.sha256(Path(path).read_bytes()).hexdigest() for name,path in m.FILES.items()}
def fake(args,**kwargs):
 assert args[:6]==['docker','run','--rm','--network','none','--entrypoint']
 return types.SimpleNamespace(returncode=0,stdout=json.dumps({"ok":True,"files":expected}).encode())
proof=m.verify('example:image',fake)
assert proof['rootOwned'] and proof['nonWritable'] and proof['files']==expected
expected['voice.tar.gz']='0'*64
try:m.verify('example:image',fake)
except m.SmokeFailure as e:
 assert e.details['code']=='source_mismatch' and e.details['file']=='voice.tar.gz' and e.details['observedSha256']=='0'*64
else:raise AssertionError('changed asset accepted')
def denied(args,**kwargs):
 return types.SimpleNamespace(returncode=0,stdout=json.dumps({'ok':False,'code':'file_rejected','path':'/usr/local/libexec/hive-template-runtime/voice.tar.gz','uid':1000,'mode':'0o666','nlink':1,'size':123}).encode())
try:m.verify('example:image',denied)
except m.SmokeFailure as e:
 assert e.details=={'code':'file_rejected','path':'/usr/local/libexec/hive-template-runtime/voice.tar.gz','uid':1000,'mode':'0o666','nlink':1,'size':123}
else:raise AssertionError('untrusted file accepted')
`;
test("built-image smoke proof compares all seven source hashes and rejects mismatches", () => {
  const result = spawnSync("python3", ["-I", "-B", "-c", driver], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
