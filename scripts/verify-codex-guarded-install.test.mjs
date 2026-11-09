import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { runtimeRelative } from "../templates/ai-dev-k8s/scripts/codex-workspace-host.mjs";
import { validateGuardianArtifact } from "./build-native-guardian.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => sha(readFileSync(path));
const privateDir = (path) => mkdirSync(path, { recursive: true, mode: 0o700 });
const driver = String.raw`
import copy,ctypes,hashlib,hmac,importlib.util,json,os,pwd,signal,socket,subprocess,sys,time,urllib.request
from pathlib import Path
sys.dont_write_bytecode=True
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
signal.signal(signal.SIGCHLD,signal.SIG_DFL)
home=Path('/home/coder'); root=Path('/fixture')
(root/'driver-pid').write_text(str(os.getpid()))
assert os.getuid()==0 and pwd.getpwuid(os.getuid()).pw_dir==str(home)
spec=importlib.util.spec_from_file_location('installed',root/'install-codex-host.py'); installed=importlib.util.module_from_spec(spec);spec.loader.exec_module(installed)
result={'manifestIdentitySynthetic':True,'schemaVersion':1,'namespaceUid':os.getuid(),'networkNamespaceIsolated':True,'accountInference':False,'cleanupAuthorized':False}
env={'PATH':'/usr/bin:/bin','HOME':str(home),'USER':'coder','LANG':'C.UTF-8','HIVE_WORKSPACE_PROFILE':'software'}
receipt_path=home/'.local/state/hive/codex-host-install/process.json'
receipt=None; stage='start'; failed=False
operation_deadline=time.monotonic()+30
def invoke(value):
 remaining=operation_deadline-time.monotonic();assert remaining>0
 p=subprocess.run(['/usr/bin/python3','-B','-I',str(root/'identity-fixture.py'),str(root/'install-codex-host.py')],input=json.dumps(value).encode(),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=min(8,remaining))
 if p.returncode!=0: raise RuntimeError('installer_rejected')
 return json.loads(p.stdout)
def rejected(call):
 try: call()
 except Exception: return True
 return False
def same(a,b): return all(a[k]==b[k] for k in ('pid','startTime','bootId','executable'))
try:
 request=json.loads((root/'request.json').read_text());config=request['config']
 first=invoke(request);assert first['status']=='started';result['firstInstall']='started'
 receipt=json.loads(receipt_path.read_text());ready=receipt['guardianStartup']['ready'];identity=receipt['process']
 target=home/'.local/share/hive/codex-host'/request['archiveSha256']
 result['archiveSha256']=request['archiveSha256']
 result['archiveEncoding']=request.get('archiveEncoding','tar')
 result['identities']={k:ready[k] for k in ('outerIdentity','guardianIdentity','workerIdentity')}
 result['pins']={k:ready[k] for k in ('configSha256','packageManifestSha256','nodeSha256','workerSha256','guardianSha256')}
 stage='repeat_after_installer_exit'
 assert installed.kernel_identity(identity['pid'])['parentPid']==os.getpid()
 again=invoke(request);assert again['status']=='already_running';result['repeatInstall']='already_running'
 assert json.loads(receipt_path.read_text())==receipt
 result['installerParentExited']=True
 assert installed.listener_owned(ready['workerIdentity']['pid'],config['port'])
 assert not installed.listener_owned(identity['pid'],config['port'])
 result['exactWorkerOwnsListener']=True
 stage='negative_verification'
 negatives={}
 for field in ('nonce','configSha256','packageManifestSha256'):
  altered=copy.deepcopy(receipt['guardianStartup']);altered['ready'][field]='x'*43 if field=='nonce' else '0'*64
  negatives[field]=rejected(lambda:installed.guarded_ready(identity,config,altered,target))
 altered=copy.deepcopy(receipt['guardianStartup']);altered['ready']['workerIdentity']['startTime']=str(int(ready['workerIdentity']['startTime'])+1)
 negatives['oldPidStartTime']=rejected(lambda:installed.guarded_ready(identity,config,altered,target))
 altered=copy.deepcopy(receipt['guardianStartup']);altered['ready']['workerIdentity']['parentPid']=identity['pid']
 negatives['wrongParent']=rejected(lambda:installed.guarded_ready(identity,config,altered,target))
 assert all(negatives.values());result['rejected']=negatives
 # Lost readiness ACK remains retained, never a second outer lifetime.
 lost=copy.deepcopy(receipt);lost['guardianStartup']['ready']=None
 receipt_path.write_text(json.dumps(lost));os.chmod(receipt_path,0o600)
 assert rejected(lambda:invoke(request));assert same(installed.process_identity(identity['pid']),identity)
 receipt_path.write_text(json.dumps(receipt));os.chmod(receipt_path,0o600)
 result['missingReadyDoesNotRestart']=True
 changed=copy.deepcopy(request);changed['config']['model']='gpt-fixture-changed'
 assert rejected(lambda:invoke(changed));assert same(installed.process_identity(identity['pid']),identity)
 result['liveConfigChangeRejected']=True
 if (root/'unused-bootstrap-mode').exists():
  stage='retain_unused_bootstrap_before_detached_restart'
  guardian=home/'.local/state/hive/codex-host-guardian'
  controller=home/'.local/state/hive/codex-project-controller'
  root_path=home/'.local/state/hive/managed-projects/root.json'
  old_outer=(guardian/'lifetime.json').read_bytes()
  old_project=(controller/'projects.json').read_bytes()
  old_root=root_path.read_bytes()
  auth=home/'.local/share/hive/codex-native/codex/auth.json'
  auth_raw=b'{"fixture":"opaque bytes, never used for authentication"}\n'
  auth.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  auth.write_bytes(auth_raw);auth.chmod(0o600)
  # Only the exact test-owned first host is stopped. The subreaper then waits
  # for its real guardian/worker descendants without altering process inspection.
  fd=os.pidfd_open(identity['pid'])
  try:
   assert same(installed.process_identity(identity['pid']),identity)
   signal.pidfd_send_signal(fd,signal.SIGKILL)
  finally:os.close(fd)
  deadline=time.monotonic()+6
  while True:
   try:
    pid,_=os.waitpid(-1,os.WNOHANG|0x40000000)
    if pid:continue
   except ChildProcessError:break
   assert time.monotonic()<deadline;time.sleep(.01)
  next_request=copy.deepcopy(request)
  next_request['config']['binding']['buildId']=json.loads((root/'fixture-ids.json').read_text())['nextBuildId']
  stage='second_unused_installer'
  second=invoke(next_request)
  assert second['status']=='started'
  receipt=json.loads(receipt_path.read_text());ready=receipt['guardianStartup']['ready'];identity=receipt['process']
  assert ready['outerIdentity']['parentPid']!=os.getpid()
  assert installed.kernel_identity(identity['pid'])['parentPid']==os.getpid()
  assert same(installed.process_identity(identity['pid']),identity)
  result['detachedInstallerParentExited']=True
  current_outer=(guardian/'lifetime.json').read_bytes()
  archive_digest=hashlib.sha256(old_outer).hexdigest()
  outer_archive=guardian/('lifetime-bootstrap-'+archive_digest+'.json')
  project_archive=controller/('projects-bootstrap-'+archive_digest+'.json')
  project_archive_raw=project_archive.read_bytes()
  assert outer_archive.read_bytes()==old_outer
  archived=json.loads(project_archive_raw)['state']
  assert archived['projectRaw']==old_project.decode() and archived['unusedRoot']['raw']==old_root.decode()
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  def identity_response():
   req=urllib.request.Request('http://127.0.0.1:'+str(config['port'])+'/guardian/identity',data=json.dumps({'nonce':os.urandom(32).hex()}).encode(),headers={'Host':'app.fixture.invalid','Content-Type':'application/json'})
   try:
    with opener.open(req,timeout=5) as response:return response.status,response.read(32769)
   except urllib.error.HTTPError as error:return error.code,error.read(32769)
  stage='actual_discovery_identity_after_installer_exit'
  status,body=identity_response()
  result['firstDiscoveryIdentityHttpStatus']=status
  result['firstDiscoveryIdentityBodyBytes']=len(body)
  assert status==200
  packet=json.loads(body)
  assert packet['startup']['outerIdentity']['parentPid']==os.getpid()
  assert packet['startup']['outerIdentity']['parentPid']!=ready['outerIdentity']['parentPid']
  assert packet['startup']['guardianIdentity']['parentPid']==identity['pid']
  assert packet['startup']['workerIdentity']['parentPid']==ready['guardianIdentity']['pid']
  assert packet['emptyRoot']['mode']=='initial-unused-remount'
  assert packet['emptyRoot']['unusedBootstrap']['oldBuildId']==config['binding']['buildId']
  assert packet['emptyRoot']['unusedBootstrap']['newBuildId']==next_request['config']['binding']['buildId']
  assert len(json.dumps(packet['emptyRoot']).encode())<=16384
  assert (guardian/'lifetime.json').read_bytes()==current_outer
  stage='stable_startup_and_history_rejections'
  rejected_changes=[]
  def replace_signed(path,mutate):
   envelope=json.loads(path.read_bytes());mutate(envelope['state'])
   envelope['signature']=hmac.new((guardian/'key').read_bytes(),json.dumps(envelope['state'],separators=(',',':')).encode(),hashlib.sha256).hexdigest()
   path.write_bytes(json.dumps(envelope,separators=(',',':')).encode());path.chmod(0o600)
  mutations=[]
  for actor in ('outerIdentity','guardianIdentity','workerIdentity'):
   for field in ('pid','startTime','bootId','executable','device','inode'):
    mutations.append((actor+'.'+field,lambda state,actor=actor,field=field:state['events'][4]['value'][actor].__setitem__(field,state['events'][4]['value'][actor][field]+1 if field=='pid' else str(state['events'][4]['value'][actor][field])+'-changed')))
  for actor in ('guardianIdentity','workerIdentity'):
   mutations.append((actor+'.parentPid',lambda state,actor=actor:state['events'][4]['value'][actor].__setitem__('parentPid',state['events'][4]['value'][actor]['parentPid']+1)))
  mutations.extend([
   ('generation',lambda state:state['events'][4]['value'].__setitem__('generation',2)),
   ('projects',lambda state:state['events'][4]['value'].__setitem__('projects',[{'projectId':'unexpected'}])),
   ('workerSha256',lambda state:state['events'][4]['value'].__setitem__('workerSha256','0'*64)),
   ('unknownStartupField',lambda state:state['events'][4]['value'].__setitem__('unexpected',True)),
   ('invalidOuterParent',lambda state:state['events'][4]['value']['outerIdentity'].__setitem__('parentPid',0)),
  ])
  for label,mutate in mutations:
   replace_signed(guardian/'lifetime.json',mutate)
   try:
    status,body=identity_response();assert status==403 and body==b''
    rejected_changes.append(label)
   finally:(guardian/'lifetime.json').write_bytes(current_outer)
  outer_archive.write_bytes(old_outer+b' ')
  try:
   status,body=identity_response();assert status==403 and body==b''
   rejected_changes.append('archivedSignedHistory')
  finally:outer_archive.write_bytes(old_outer)
  assert identity_response()[0]==200
  assert outer_archive.read_bytes()==old_outer and project_archive.read_bytes()==project_archive_raw
  assert (guardian/'lifetime.json').read_bytes()==current_outer and root_path.read_bytes()==old_root and auth.read_bytes()==auth_raw
  assert json.loads((controller/'projects.json').read_text())['state']['projects']==json.loads(old_project)['state']['projects']
  result['identities']={k:ready[k] for k in ('outerIdentity','guardianIdentity','workerIdentity')}
  inventory=json.loads((root/'last-process-inventory.json').read_text())
  assert all(ready[k]['pid'] in inventory for k in ('outerIdentity','guardianIdentity','workerIdentity'))
  result['unusedBootstrapDiscovery']={'httpStatus':200,'mode':packet['emptyRoot']['mode'],'proposalBytes':len(json.dumps(packet['emptyRoot']).encode()),'rawHistoryUnchanged':True,'authBytesUnchanged':True,'rejectedChanges':rejected_changes,'processInventoryProjected':True,'allKnownFixtureActorsInspected':True,'unrelatedPrimaryProcessUniverseExcluded':True}
 elif (root/'idle-mode').exists():
  stage='idle_close_restart'
  def signed(path,keypath):
   saved=json.loads(path.read_text());encoded=json.dumps(saved['state'],separators=(',',':'),ensure_ascii=False).encode()
   assert hmac.compare_digest(saved['signature'],hmac.new(keypath.read_bytes(),encoded,hashlib.sha256).hexdigest())
   return saved['state']
  def close_idle(receipt):
   guardian=home/'.local/state/hive/codex-host-guardian';controller=home/'.local/state/hive/codex-project-controller'
   assert not (guardian/'controller.json').exists()
   assert signed(controller/'projects.json',controller/'projects.key')['projects']=={}
   expected=receipt['process'];assert same(installed.process_identity(expected['pid']),expected)
   fd=os.pidfd_open(expected['pid'])
   try:
    assert same(installed.process_identity(expected['pid']),expected)
    signal.pidfd_send_signal(fd,signal.SIGTERM)
   finally:os.close(fd)
   deadline=time.monotonic()+8;outer_status=None
   while True:
    try:
     pid,status=os.waitpid(-1,os.WNOHANG|0x40000000)
     if pid==expected['pid']:outer_status=status
     if pid:continue
    except ChildProcessError:break
    assert time.monotonic()<deadline;time.sleep(.01)
   assert outer_status==0
   state=signed(guardian/'lifetime.json',guardian/'key');events=[e['name'] for e in state['events']]
   assert state['phase']=='idleClosed'
   assert events==['begin','ready','launchIntent','open','startupReady','closing','workerClosed','receipt','idleTreeExited','idleClosed']
   exited=state['events'][-2]['value'];assert exited['finalWaitResult']=='ECHILD' and exited['guardianExited'] is True
   assert exited['projects']==[] and exited['decisions']==[] and state['events'][6]['value']['snapshots']==[]
   assert exited['workerBarrier']['barrierId']==signed(controller/'projects.json',controller/'projects.key')['guardianBarrier']['barrierId']
   return {'events':events,'lifetimeId':exited['lifetimeId'],'finalWaitResult':exited['finalWaitResult'],'outerExitCode':0,'allChildrenReaped':True}
  first_idle=close_idle(receipt)
  changed=copy.deepcopy(request);changed['config']['model']='gpt-fixture-changed'
  second=invoke(changed);assert second['status']=='started'
  receipt=json.loads(receipt_path.read_text());second_ready=receipt['guardianStartup']['ready']
  assert second_ready['lifetimeId']!=first_idle['lifetimeId']
  assert second_ready['bindingDigest']!=ready['bindingDigest']
  controller=home/'.local/state/hive/codex-project-controller';guardian=home/'.local/state/hive/codex-host-guardian'
  inner_archives=list(controller.glob('projects-idle-*.json'));outer_archives=list(guardian.glob('lifetime-idle-*.json'))
  assert len(inner_archives)==len(outer_archives)==1
  inner=signed(inner_archives[0],controller/'projects.key');outer=signed(outer_archives[0],guardian/'key')
  archived_receipt=outer['events'][-2]['value']
  assert inner['receiptDigest']==hashlib.sha256(json.dumps(archived_receipt,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
  assert inner['projectState']['guardianLifetimeId']==first_idle['lifetimeId']
  assert inner['projectState']['guardianBarrier']['barrierId']==archived_receipt['workerBarrier']['barrierId']
  result['idleLifetimes']=[first_idle,close_idle(receipt)]
  result['idleRestartWithChangedBinding']=True
  result['authenticatedInnerArchive']=True
  result['noAuthenticationFiles']=not any((home/p).exists() for p in ('.codex/auth.json','.local/share/hive/codex-native/codex/auth.json'))
  assert result['noAuthenticationFiles']
 else:
  stage='default_denied_preparation'
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  body=(root/'start-ticket.json').read_bytes()
  req=urllib.request.Request('http://127.0.0.1:'+str(config['port'])+'/projects/tasks/start',data=body,headers={'Host':'app.fixture.invalid','Content-Type':'application/json'})
  with opener.open(req,timeout=3) as response: assert response.status==200
  projectId=json.loads((root/'fixture-ids.json').read_text())['projectId']
  controller_path=home/'.local/state/hive/codex-project-controller/projects.json'
  deadline=time.monotonic()+3
  while True:
   state=json.loads(controller_path.read_text())['state'];task=state['projects'][projectId]['task']
   if task and task['phase']=='blocked':break
   assert time.monotonic()<deadline;time.sleep(.02)
  assert task['guardianPreparation'] and not task.get('guardianAdmission') and not task.get('prepared')
  assert task['nativeCreationAttempted'] is False and task['firstPromptSubmissionAttempted'] is False
  assert (home/'projects/.hive-managed').is_dir()
  assert not any((home/'projects/.hive-managed').iterdir())
  assert not (home/'.local/state/hive/codex-project-supervisor').exists()
  result['defaultPreparationDenied']=True
  result['noNativeRuntimeStarted']=True
  result['noAuthenticationFiles']=not any((home/p).exists() for p in ('.codex/auth.json','.local/share/hive/codex-native/codex/auth.json'))
  assert result['noAuthenticationFiles']
 result['status']='passed'
except Exception as error:
 failed=True;result.update(status='failed',stage=stage,errorType=type(error).__name__)
finally:
 # Driver is the dedicated single subreaper for this fixture only. Signal the
 # exact recorded outer first; production abort drains its own guardian tree.
 try:
  if receipt is None and receipt_path.exists():receipt=json.loads(receipt_path.read_text())
  if receipt:
   expected=receipt['process'];actual=installed.process_identity(expected['pid'])
   assert same(actual,expected)
   fd=os.pidfd_open(expected['pid'])
   try:
    assert same(installed.process_identity(expected['pid']),expected)
    signal.pidfd_send_signal(fd,signal.SIGTERM)
   finally:os.close(fd)
 except (FileNotFoundError,ProcessLookupError):pass
 deadline=time.monotonic()+6;reaps=0;empty=False
 while time.monotonic()<deadline and reaps<128:
  try:
   pid,_=os.waitpid(-1,os.WNOHANG|0x40000000)
   if pid:reaps+=1;continue
  except ChildProcessError:empty=True;break
  time.sleep(.01)
 # On failure retain files unless every descendant is gone. No broad process
 # group kill and no unrelated PID inventory are used.
 result['cleanup']={'allFixtureChildrenReaped':empty,'reaped':reaps,'deadlineBoundSeconds':6}
 if not empty:result['status']='failed';failed=True
 (root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 if failed:sys.exit(1)
`;

function guardedInstallFixture(idle, unusedBootstrap = false) {
  const root = resolve("."),
    directory = mkdtempSync(join(tmpdir(), "hive-guarded-install-"));
  const home = join(directory, "home"),
    bundle = join(directory, "bundle");
  privateDir(home);
  if (idle) writeFileSync(join(directory, "idle-mode"), "1");
  if (unusedBootstrap) writeFileSync(join(directory, "unused-bootstrap-mode"), "1");
  const evidence = process.env.HIVE_GUARDED_INSTALL_EVIDENCE_PATH;
  const artifactDirectory = resolve(
    process.env.HIVE_GUARDIAN_ARTIFACT_DIR || "/tmp/hive-guardian-ci-17dbf25",
  );
  const artifact = validateGuardianArtifact(root, artifactDirectory);
  const sourcePaths = [
    "scripts/verify-codex-guarded-install.test.mjs",
    "scripts/fixtures/workspace-identity-install.py",
    "scripts/fixtures/guarded-install-process-inventory.py",
    "scripts/build-codex-host-bundle.mjs",
    "scripts/build-native-guardian.mjs",
    ...[
      "install-codex-host.py",
      "codex-native-guardian.c",
      "codex-empty-root.mjs",
      "codex-native-guardian.mjs",
      "codex-guardian-startup.mjs",
      "codex-guardian-worker.mjs",
      "codex-host-guardian.mjs",
      "codex-workspace-host-outer.mjs",
      "codex-workspace-host-worker.mjs",
      "codex-workspace-host.mjs",
      "codex-project-controller.mjs",
      "codex-project-discovery.mjs",
      "codex-process-identity.mjs",
    ].map((name) => `templates/ai-dev-k8s/scripts/${name}`),
  ];
  const sourceSha256 = Object.fromEntries(sourcePaths.map((path) => [path, fileSha(path)]));
  const primaryHome = userInfo().homedir;
  const protectedPaths = [
    join(primaryHome, ".config/hive/codex-host.json"),
    join(primaryHome, ".local/state/hive/codex-host-install"),
    join(primaryHome, ".local/state/hive/codex-host-guardian"),
  ];
  const metadata = () =>
    Object.fromEntries(
      protectedPaths.map((path) => {
        if (!existsSync(path)) return [path, null];
        const stat = lstatSync(path);
        return [path, { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size }];
      }),
    );
  const primaryBefore = metadata();
  let success = false;
  try {
    execFileSync(process.execPath, ["scripts/build-codex-host-bundle.mjs", bundle], {
      env: { PATH: process.env.PATH, HIVE_GUARDIAN_ARTIFACT_DIR: artifactDirectory },
      timeout: 10000,
      stdio: "pipe",
    });
    if (unusedBootstrap) {
      // Extend the established fixture-only /proc projection to its complete
      // descendant tree. Production bytes and process inspection stay exact.
      const managedPath = join(bundle, "managed-projects.py"),
        projection = readFileSync("scripts/fixtures/guarded-install-process-inventory.py", "utf8");
      const managed = readFileSync(managedPath, "utf8");
      assert.equal(managed.split("from pathlib import Path\n").length, 2);
      chmodSync(managedPath, 0o600);
      writeFileSync(
        managedPath,
        managed.replace("from pathlib import Path\n", `from pathlib import Path\n${projection}\n`),
      );
      chmodSync(managedPath, 0o500);
      const manifestPath = join(bundle, "package-manifest.json"),
        manifest = JSON.parse(readFileSync(manifestPath));
      manifest.files["managed-projects.py"] = fileSha(managedPath);
      chmodSync(manifestPath, 0o600);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      chmodSync(manifestPath, 0o400);
    }
    const nativeExecutable = realpathSync(
      process.env.HIVE_TEST_CODEX_EXECUTABLE ||
        "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    );
    const vendor = dirname(dirname(nativeExecutable)),
      nativeTarget = join(home, runtimeRelative);
    const pins = {
      "bin/codex": "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5",
      "bin/codex-code-mode-host":
        "522935d4392ec9674fab60b239b5495992c6a93e4deb65113a216b6f5451ccd4",
      "codex-resources/bwrap": "755c8d6a9b893905a4aabab058bd6c02c453e5e8653adb84fc08e570607f3f36",
      "codex-path/rg": "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
    };
    for (const [name, digest] of Object.entries(pins)) {
      assert.equal(fileSha(join(vendor, name)), digest);
      const target = join(nativeTarget, name);
      privateDir(dirname(target));
      copyFileSync(join(vendor, name), target, constants.COPYFILE_FICLONE);
      chmodSync(target, 0o500);
      assert.equal(fileSha(target), digest);
    }
    copyFileSync(
      realpathSync(process.execPath),
      join(directory, "node"),
      constants.COPYFILE_FICLONE,
    );
    chmodSync(join(directory, "node"), 0o500);
    copyFileSync(
      "scripts/fixtures/workspace-identity-install.py",
      join(directory, "identity-fixture.py"),
    );
    copyFileSync(
      "templates/ai-dev-k8s/scripts/install-codex-host.py",
      join(directory, "install-codex-host.py"),
    );
    writeFileSync(join(directory, "passwd"), "coder:x:0:0:Fixture only:/home/coder:/bin/sh\n", {
      mode: 0o600,
    });
    writeFileSync(join(directory, "group"), "coder:x:0:\n", { mode: 0o600 });
    writeFileSync(join(directory, "driver.py"), driver, { mode: 0o600 });
    const ids = Object.fromEntries(
      [
        "hiveUserId",
        "ownerId",
        "workspaceId",
        "buildId",
        "agentId",
        "templateId",
        "appId",
        "projectId",
        "taskId",
        "requestId",
        "nextBuildId",
      ].map((key) => [key, randomUUID()]),
    );
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { projectId, taskId, requestId, nextBuildId: _nextBuildId, ...identity } = ids;
    const config = {
      schemaVersion: 1,
      enabled: true,
      profile: "software",
      binding: {
        ...identity,
        coderOrigin: "https://coder.fixture.invalid",
        appOrigin: "https://app.fixture.invalid",
      },
      hiveOrigin: "https://hive.fixture.invalid",
      issuerPublicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
      issuerKeyId: "fixture",
      port: 32179,
      model: "gpt-6.1-sol",
      effort: "low",
      managerEnabled: idle || unusedBootstrap,
      ...(idle || unusedBootstrap ? { deliveryExecutionEnabled: true } : {}),
      nativeIsolationEnabled: true,
      guardianEnabled: true,
    };
    // An enrolled, task-free project is synthetic fixture state, not an admission.
    const controller = join(home, ".local/state/hive/codex-project-controller");
    privateDir(controller);
    const key = Buffer.alloc(32, 7),
      state = {
        schemaVersion: 1,
        ownerId: ids.ownerId,
        workspaceId: ids.workspaceId,
        projects: idle
          ? {}
          : {
              [projectId]: {
                projectId,
                repositoryId: "987654321012345678",
                expectedAccountId: "123456789",
                createdAt: Date.now(),
                task: null,
              },
            },
      };
    writeFileSync(join(controller, "projects.key"), key, { mode: 0o600 });
    writeFileSync(
      join(controller, "projects.json"),
      JSON.stringify({
        state,
        signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
      }),
      { mode: 0o600 },
    );
    const request = {
      schemaVersion: 1,
      projectId,
      taskId,
      requestId,
      repositoryId: "987654321012345678",
      expectedAccountId: "123456789",
      revision: "a".repeat(40),
      model: config.model,
      effort: config.effort,
      text: "Fixture request must be rejected before preparation.",
    };
    const now = Math.floor(Date.now() / 1000),
      header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "fixture" })).toString(
        "base64url",
      ),
      payload = Buffer.from(
        JSON.stringify({
          iss: config.hiveOrigin,
          aud: config.binding.appOrigin,
          scope: "projects:task:start",
          jti: randomUUID(),
          iat: now,
          exp: now + 60,
          binding: config.binding,
          request,
        }),
      ).toString("base64url");
    writeFileSync(
      join(directory, "start-ticket.json"),
      JSON.stringify({
        ticket: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`,
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(directory, "fixture-ids.json"), JSON.stringify(ids), { mode: 0o600 });
    writeFileSync(join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 });
    execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        "import io,tarfile,pathlib,hashlib,json,base64,sys,lzma;root=pathlib.Path(sys.argv[1]);out=io.BytesIO();tar=tarfile.open(fileobj=out,mode='w');[(lambda p:tar.add(p,arcname=str(p.relative_to(root/'bundle')),recursive=False))(p) for p in sorted((root/'bundle').rglob('*')) if p.is_file()];tar.close();raw=out.getvalue();(root/'request.json').write_text(json.dumps({'schemaVersion':1,'archive':base64.b64encode(lzma.compress(raw,format=lzma.FORMAT_XZ,check=lzma.CHECK_CRC64,preset=6)).decode(),'archiveEncoding':'xz','archiveSha256':hashlib.sha256(raw).hexdigest(),'config':json.loads((root/'config.json').read_text())}))",
        directory,
      ],
      { timeout: 5000 },
    );
    const args = [
      "--unshare-user",
      "--uid",
      "0",
      "--gid",
      "0",
      "--unshare-net",
      "--die-with-parent",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      join(directory, "node"),
      "/usr/bin/node",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--tmpfs",
      "/etc",
      "--ro-bind",
      join(directory, "passwd"),
      "/etc/passwd",
      "--ro-bind",
      join(directory, "group"),
      "/etc/group",
      "--ro-bind",
      "/etc/nsswitch.conf",
      "/etc/nsswitch.conf",
      "--bind",
      "/proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      directory,
      "/fixture",
      "--bind",
      home,
      "/home/coder",
      "--chdir",
      "/fixture",
      "/usr/bin/python3",
      "-B",
      "-I",
      "/fixture/driver.py",
    ];
    let failure;
    try {
      execFileSync(join(vendor, "codex-resources/bwrap"), args, {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/home/coder",
          LANG: "C.UTF-8",
          HIVE_WORKSPACE_PROFILE: "software",
        },
        timeout: 45000,
        stdio: "pipe",
      });
    } catch (error) {
      failure = error;
    }
    const resultPath = join(directory, "result.json");
    const result = existsSync(resultPath)
      ? JSON.parse(readFileSync(resultPath))
      : { status: "failed", stage: "namespace_driver", errorType: "no_result" };
    assert.deepEqual(metadata(), primaryBefore);
    result.primaryPathsUnchanged = true;
    result.namespaceHostUid = process.getuid();
    result.guardianArtifact = artifact.manifest;
    result.nativePins = pins;
    result.nodeSha256 = fileSha(join(directory, "node"));
    result.primaryHomeMounted = false;
    result.sourceSha256 = sourceSha256;
    result.sourceStable = sourcePaths.every((path) => fileSha(path) === sourceSha256[path]);
    result.recordedProcessesGone = Object.values(result.identities ?? {}).every(
      (identity) => !existsSync(`/proc/${identity.pid}`),
    );
    if (evidence) {
      privateDir(dirname(resolve(evidence)));
      writeFileSync(
        resolve(
          unusedBootstrap
            ? `${evidence}.unused-bootstrap.json`
            : idle
              ? `${evidence}.idle.json`
              : evidence,
        ),
        `${JSON.stringify(result, null, 2)}\n`,
        { flag: "wx" },
      );
    }
    assert.equal(
      failure,
      undefined,
      `fixture failed at ${result.stage ?? "unknown"}; private scratch retained: ${directory}`,
    );
    assert.equal(result.status, "passed");
    assert.equal(result.cleanup.allFixtureChildrenReaped, true);
    assert.equal(result.sourceStable, true);
    assert.equal(result.recordedProcessesGone, true);
    success = true;
  } finally {
    if (success) rmSync(directory, { recursive: true, force: true });
    else process.stderr.write(`Guarded installer fixture retained: ${directory}\n`);
  }
}

test(
  "detached installer exit preserves actual discovery identity and unused bootstrap proposal",
  {
    skip: process.env.HIVE_TEST_GUARDED_INSTALL !== "1",
    timeout: 60000,
  },
  () => guardedInstallFixture(false, true),
);

for (const idle of [false, true])
  test(
    idle
      ? "actual packaged idle host closes with ECHILD and restarts from authenticated inner archival"
      : "fixed Python installer and guarded outer attest exact worker readiness and refuse duplicate or unauthorized execution",
    {
      skip: process.env.HIVE_TEST_GUARDED_INSTALL !== "1",
      timeout: 60000,
    },
    () => guardedInstallFixture(idle),
  );
