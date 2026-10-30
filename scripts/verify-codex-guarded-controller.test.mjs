import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openGuardedHost } from "../templates/ai-dev-k8s/scripts/codex-host-guardian.mjs";
import { processParentPid } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import {
  startWorkspaceHost,
  validateHostConfig,
} from "../templates/ai-dev-k8s/scripts/codex-workspace-host.mjs";
import { buildNativeGuardian } from "./build-native-guardian.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const fileSha = (p) => sha(readFileSync(p));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check) {
  for (let n = 0; n < 400; n++) {
    const value = check();
    if (value) return value;
    await pause(25);
  }
  throw new Error("guarded_controller_fixture_deadline");
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

for (const executionMode of ["direct", "isolated"])
  test(`actual guardian worker contains ${executionMode} controller preparation, native, CLI and PTY until the durable full-set barrier`, {
    skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
    timeout: 30000,
  }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "hive-guarded-controller-"));
    const home = join(dir, "home"),
      packageDirectory = join(dir, "package"),
      journalDirectory = join(dir, "controller");
    for (const p of [
      home,
      journalDirectory,
      join(home, ".codex"),
      join(home, "projects/.hive-managed/github/123/checkout"),
    ])
      mkdirSync(p, { recursive: true, mode: 0o700 });
    const marker = join(dir, "ready.json"),
      failure = join(dir, "failure.json"),
      ptyMarker = join(dir, "pty.json"),
      barrierMarker = join(dir, "barrier.json"),
      preparedMarker = join(dir, "prepared.json");
    const sourcePaths = [
      "templates/ai-dev-k8s/scripts/codex-native-guardian.c",
      "templates/ai-dev-k8s/scripts/codex-native-guardian.mjs",
      "templates/ai-dev-k8s/scripts/codex-host-guardian.mjs",
      "templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs",
      "templates/ai-dev-k8s/scripts/codex-guardian-startup.mjs",
      "templates/ai-dev-k8s/scripts/codex-workspace-host-outer.mjs",
      "templates/ai-dev-k8s/scripts/codex-project-controller.mjs",
      "templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
      "templates/ai-dev-k8s/scripts/codex-native-namespace.mjs",
      "templates/ai-dev-k8s/scripts/codex-process-identity.mjs",
      "templates/ai-dev-k8s/scripts/codex-workspace-host.mjs",
      "templates/ai-dev-k8s/scripts/codex-workspace-host-worker.mjs",
      "templates/ai-dev-k8s/scripts/codex-project-discovery.mjs",
      "templates/ai-dev-k8s/scripts/codex-project-gateway.mjs",
      "templates/ai-dev-k8s/scripts/codex-project-terminal.mjs",
      "templates/ai-dev-k8s/scripts/codex-session-bridge.mjs",
      "templates/ai-dev-k8s/scripts/codex-host-registration.mjs",
      "templates/ai-dev-k8s/scripts/delivery-manager-adapter.mjs",
      "templates/ai-dev-k8s/scripts/delivery-native-spool.mjs",
      "scripts/verify-codex-guarded-controller.test.mjs",
      "scripts/build-native-guardian.mjs",
    ];
    const sourceDigests = Object.fromEntries(sourcePaths.map((p) => [p, fileSha(p)]));
    let host,
      cleanupSafe = false,
      requests = 0;
    const provider = createServer((req, res) => {
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1048576) req.destroy();
      });
      req.on("end", () => {
        if (++requests > 2) {
          res.writeHead(429);
          res.end();
          return;
        }
        const item = {
          id: "guarded_message",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "GUARDED_LOCAL_MOCK_COMPLETE", annotations: [] }],
        };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of [
          {
            type: "response.created",
            response: { id: "guarded_response", status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: "GUARDED_LOCAL_MOCK_COMPLETE",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "guarded_response",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
    });
    await new Promise((done) => provider.listen(0, "127.0.0.1", done));
    t.after(async () => {
      provider.closeAllConnections();
      await new Promise((done) => provider.close(done));
      if (host && host.state.phase !== "closed") {
        const aborted = await host.abort();
        cleanupSafe = aborted.held !== true;
      }
      if (cleanupSafe) rmSync(dir, { recursive: true, force: true });
      else console.error(`Guarded fixture retained after uncertain cleanup: ${dir}`);
    });
    const executable = realpathSync(
      process.env.HIVE_TEST_CODEX_EXECUTABLE ||
        "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    );
    const nativeSha = fileSha(executable);
    assert.equal(nativeSha, "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5");
    writeFileSync(
      join(home, ".codex/config.toml"),
      `model="gpt-6.1-sol"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="read-only"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="Local mock only"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\napps=false\nplugins=false\nhooks=false\nmemories=false\n`,
      { mode: 0o600 },
    );
    const ids = Object.fromEntries(
      ["ownerId", "workspaceId", "buildId", "projectId", "taskId", "requestId"].map((k) => [
        k,
        randomUUID(),
      ]),
    );
    const start = {
      schemaVersion: 1,
      projectId: ids.projectId,
      taskId: ids.taskId,
      requestId: ids.requestId,
      repositoryId: "123",
      expectedAccountId: "456",
      revision: "a".repeat(40),
      model: "gpt-6.1-sol",
      effort: "low",
      text: "Synthetic guardian composition check; local provider only.",
    };
    const config = {
      stateDirectory: journalDirectory,
      ownerId: ids.ownerId,
      workspaceId: ids.workspaceId,
      model: start.model,
      effort: start.effort,
    };
    const buildMetadata = buildNativeGuardian(resolve("."), packageDirectory);
    const ptyScript = `import os,pty,json\npid,master=pty.fork()\nif pid==0: os.execve('/usr/bin/tmux',['tmux','-S',${JSON.stringify(join(home, ".local/state/hive/codex-project-supervisor/tmux.sock"))},'attach-session','-t',${JSON.stringify(`=project-${sha(ids.projectId).slice(0, 24)}`)}],{'PATH':'/usr/bin:/bin','TERM':'xterm-256color'})\nwith open(${JSON.stringify(ptyMarker)},'w') as f: json.dump({'pid':os.getpid(),'child':pid},f)\nwhile True: os.read(master,8192)`;
    const authorityProbe =
      "import os,sys\nassert not any(k in os.environ for k in ['CODER_AGENT_TOKEN','CODER_AGENT_TOKEN_FILE','GITHUB_TOKEN','CODER_SESSION_TOKEN'])\nfor p in sys.argv[1:]:\n try: open(p,'rb').close()\n except (PermissionError,FileNotFoundError): continue\n raise SystemExit(2)\nprint('GUARDIAN_AUTHORITY_DENIED')";
    const script = `
import {connectGuardianWorker} from './templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs';
import {createProjectController} from './templates/ai-dev-k8s/scripts/codex-project-controller.mjs';
import {openSupervisor,launchNative} from './templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
let controller,supervisor,native,ready;
const guard=await connectGuardianWorker({onLost:()=>{controller?.loseAdmission();supervisor?.revoke()},onCloseAdmission:async barrier=>{
 const receipt=controller.closeAdmission(barrier);await supervisor.closeAdmission(barrier);
 let denied=false;try{controller.assertExecution(${JSON.stringify(ids.projectId)})}catch{denied=true}
 writeFileSync(${JSON.stringify(barrierMarker)},JSON.stringify({receipt,denied}));
}});
const authority={assert:()=>controller.assertRuntimeExecution(),fence:()=>controller.fenceRuntimeExecution()};
const start=${JSON.stringify(start)},ids=${JSON.stringify(ids)};
controller=createProjectController(${JSON.stringify(config)},{guardian:guard,guardianBuildId:ids.buildId,
 resolveRepository:async()=>({schemaVersion:1,providerAccountId:'456',repository:{providerRepositoryId:'123',permissions:{push:true},archived:false},defaultRevision:start.revision}),
 inspectCheckout:async()=>ready??{status:'not_created',lease:null},
 prepareCheckout:async()=>{authority.assert();execFileSync('/usr/bin/git',['init','--quiet',${JSON.stringify(join(home, "projects/.hive-managed/github/123/checkout"))}]);ready={status:'ready',checkoutVerified:true,revision:start.revision,checkoutIncarnation:'fixture-incarnation',checkoutIdentity:{device:'1',inode:'2'},renewalSequence:0,lease:{taskId:ids.taskId,id:'fixture-lease',generation:1,expiresAt:Date.now()/1000+900}};writeFileSync(${JSON.stringify(preparedMarker)},JSON.stringify(ready));return ready},
 openRuntime:async projects=>{supervisor=await openSupervisor({schemaVersion:1,profile:'software',ownerId:ids.ownerId,workspaceId:ids.workspaceId,buildId:ids.buildId,codexExecutable:${JSON.stringify(executable)},codexSha256:${JSON.stringify(nativeSha)},projects,executionMode:${JSON.stringify(executionMode)}},{home:${JSON.stringify(home)},executionAuthority:authority,runtimeFactory:async args=>{
 native=await launchNative({...args,...(${JSON.stringify(executionMode)}==='isolated'?{fixtureProvider:{baseUrl:${JSON.stringify(`http://127.0.0.1:${provider.address().port}/v1`)}}}:{})});native.inspectLease=project=>({ok:true,data:{...ready,checkoutDirectory:${JSON.stringify(join(home, "projects/.hive-managed/github/123/checkout"))},lease:{...ready.lease,id:project.leaseId,taskId:project.taskId,generation:project.leaseGeneration}}});return native;
 }});return {supervisor,registration:{currentRegistration:()=>({serverInstanceId:supervisor.state.serverInstanceId,threads:Object.entries(supervisor.state.projects).filter(([,p])=>p.threadId).map(([projectId,p])=>({projectId,threadId:p.threadId}))})}};
}});
try{
 const {taskId,revision,model,effort,text,...open}=start;await controller.handle('/projects/open',open);await controller.handle('/projects/tasks/start',start);
 for(let n=0;n<160;n++){await controller.drain();const status=await controller.handle('/projects/tasks/status',{schemaVersion:1,projectId:ids.projectId,taskId:ids.taskId,requestId:ids.requestId});if(status.phase==='blocked')throw new Error(status.reason);if(status.phase==='running')break;await new Promise(r=>setTimeout(r,25));}
 await controller.drain();
 let history;for(let n=0;n<160;n++){history=await native.call('thread/turns/list',{threadId:supervisor.state.projects[ids.projectId].threadId,limit:10,sortDirection:'asc',itemsView:'full'});if(JSON.stringify(history).includes('GUARDED_LOCAL_MOCK_COMPLETE'))break;await new Promise(r=>setTimeout(r,25));}
 if(!JSON.stringify(history).includes('GUARDED_LOCAL_MOCK_COMPLETE'))throw new Error('mock_history_missing');
 const denied=${JSON.stringify(executionMode)}==='isolated'?await native.call('command/exec',{command:['/usr/bin/python3','-I','-c',${JSON.stringify(authorityProbe)},${JSON.stringify(join(dir, "outer/key"))},${JSON.stringify(join(journalDirectory, "projects.key"))},'/proc/'+process.pid+'/fd/3','/proc/'+process.pid+'/environ'],cwd:${JSON.stringify(join(home, "projects/.hive-managed/github/123/checkout"))},permissionProfile:'hive-native-isolated',timeoutMs:3000,outputBytesCap:1024}):null;
 if(${JSON.stringify(executionMode)}==='isolated'&&(denied.exitCode!==0||denied.stdout.trim()!=='GUARDIAN_AUTHORITY_DENIED'))throw new Error('outer_authority_accessible');
 const pty=spawn('/usr/bin/python3',['-I','-c',${JSON.stringify(ptyScript)}],{env:{PATH:'/usr/bin:/bin'},stdio:'ignore'});
 const tmuxPid=Number(execFileSync('/usr/bin/tmux',['-S',${JSON.stringify(join(home, ".local/state/hive/codex-project-supervisor/tmux.sock"))},'display-message','-p','#{pid}'],{encoding:'utf8'}).trim());
 writeFileSync(${JSON.stringify(marker)},JSON.stringify({workerPid:process.pid,nativePid:native.processIdentity.pid,ptyPid:pty.pid,tmuxPid,executionIdentity:native.executionIdentity,outerAuthorityDenied:denied?.exitCode===0&&denied?.stdout.trim()==='GUARDIAN_AUTHORITY_DENIED',rootThreadId:supervisor.state.projects[ids.projectId].threadId,historyComplete:true}));
}catch(error){writeFileSync(${JSON.stringify(failure)},JSON.stringify({code:String(error.message).slice(0,120)}));}
setInterval(()=>{},1000);
`;
    await build({
      stdin: { contents: script, resolveDir: resolve(".") },
      outfile: join(packageDirectory, "fixture-worker.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: 'import {createRequire as fixtureRequire} from "node:module"; const require=fixtureRequire(import.meta.url);',
      },
      logLevel: "silent",
    });
    execFileSync(process.execPath, ["--check", join(packageDirectory, "fixture-worker.mjs")], {
      stdio: "pipe",
    });
    writeFileSync(
      join(packageDirectory, "package-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        guardian: buildMetadata,
        files: Object.fromEntries(
          ["codex-native-guardian", "fixture-worker.mjs"].map((name) => [
            name,
            fileSha(join(packageDirectory, name)),
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    const signedState = () => {
      const value = readJson(join(journalDirectory, "projects.json")),
        key = readFileSync(join(journalDirectory, "projects.key"));
      const expected = createHmac("sha256", key).update(JSON.stringify(value.state)).digest();
      assert.equal(timingSafeEqual(expected, Buffer.from(value.signature, "hex")), true);
      return value.state;
    };
    let allow = false,
      admissionCheckedBeforePrepare = false;
    host = await openGuardedHost({
      packageDirectory,
      packageManifestSha256: fileSha(join(packageDirectory, "package-manifest.json")),
      workerName: "fixture-worker.mjs",
      nodeExecutable: realpathSync(process.execPath),
      nodeSha256: fileSha(realpathSync(process.execPath)),
      workerCwd: dir,
      workerEnvironment: {
        HIVE_WORKSPACE_PROFILE: "software",
        CODER_AGENT_TOKEN: "fixture-synthetic-no-authority",
      },
      stateDirectory: join(dir, "outer"),
      bindingDigest: "c".repeat(64),
      authorizeAdmission: async (project) => {
        const task = signedState().projects[ids.projectId].task;
        assert.equal(project.projectId, ids.projectId);
        assert.equal(project.bindingDigest, sha(JSON.stringify(task.guardianPreparation)));
        assert.equal(task.guardianPreparation.baseSha, start.revision);
        if (!existsSync(preparedMarker)) admissionCheckedBeforePrepare = true;
        return project;
      },
      authorizeDrain: async (value) => {
        assert.equal(allow, true, "fixture_controller_active");
        const task = signedState().projects[ids.projectId].task;
        assert.equal(task.guardianPrepared.leaseId, task.prepared.leaseId);
        const decisions = value.projects.map((p) => ({ ...p, decisionId: randomUUID() }));
        const fd = openSync(join(dir, "fixture-controller-closed.json"), "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ fixtureOnly: true, ...value, decisions }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const directoryFd = openSync(dir, "r");
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
        return decisions;
      },
    });
    await until(() => {
      if (existsSync(failure)) return true;
      try {
        return readJson(marker).workerPid && readJson(ptyMarker).child;
      } catch {
        // File creation precedes the fixture writer's completed JSON write.
        // Partial marker data grants no readiness; bounded polling waits for it.
        return false;
      }
    });
    assert.equal(
      existsSync(failure),
      false,
      existsSync(failure) ? readFileSync(failure, "utf8") : "",
    );
    const ready = readJson(marker),
      pty = readJson(ptyMarker);
    assert.equal(ready.workerPid, host.state.workerPid);
    assert.equal(processParentPid(ready.workerPid), host.state.guardian.guardianIdentity.pid);
    if (executionMode === "isolated") {
      assert.equal(ready.executionIdentity.mode, "isolated");
      assert.equal(processParentPid(ready.executionIdentity.wrapper.pid), ready.workerPid);
      assert.equal(
        processParentPid(ready.executionIdentity.monitor.pid),
        ready.executionIdentity.wrapper.pid,
      );
      assert.equal(processParentPid(ready.nativePid), ready.executionIdentity.monitor.pid);
      assert.equal(ready.outerAuthorityDenied, true);
    } else assert.equal(processParentPid(ready.nativePid), ready.workerPid);
    assert.equal(processParentPid(ready.tmuxPid), host.state.guardian.guardianIdentity.pid);
    assert.equal(processParentPid(pty.pid), ready.workerPid);
    assert.equal(processParentPid(pty.child), pty.pid);
    assert.equal(admissionCheckedBeforePrepare, true);
    await assert.rejects(host.drain(), /fixture_controller_active/);
    assert.equal(existsSync(`/proc/${ready.nativePid}`), true);
    allow = true;
    const receipt = await host.drain();
    cleanupSafe = true;
    assert.equal(receipt.finalWaitResult, "ECHILD");
    assert.equal(receipt.cleanupAuthorized, false);
    assert.equal(readJson(barrierMarker).denied, true);
    for (const pid of [
      ready.workerPid,
      ready.nativePid,
      ready.tmuxPid,
      pty.pid,
      pty.child,
      ...(executionMode === "isolated"
        ? [ready.executionIdentity.wrapper.pid, ready.executionIdentity.monitor.pid]
        : []),
    ])
      assert.equal(existsSync(`/proc/${pid}`), false);
    assert.equal(requests, 1);
    const sourceStable = sourcePaths.every((p) => fileSha(p) === sourceDigests[p]);
    assert.equal(sourceStable, true, "fixture_source_changed_during_run");
    const evidence = {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      baseRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceDigests,
      sourceStable,
      passed: true,
      nativeVersion: "0.165.0",
      executionMode,
      nativeSha256: nativeSha,
      providerRequests: requests,
      accountCredentials: false,
      accountInference: false,
      cloudMutations: false,
      checks: {
        preparationAdmissionBeforeHelper: true,
        exactGuardianWorkerNativeParentEdges: true,
        exactPythonPtyParentEdges: true,
        adoptedTmuxDaemonVerified: true,
        actualGitInitAfterAdmission: true,
        ...(executionMode === "isolated"
          ? {
              outerJournalKeyAndWorkerFdDenied: true,
              originalThreeEdgeLeaseChainPreserved: true,
              workerAgentEnvNotForwardedToNativeTool: true,
            }
          : {}),
        activeProjectDrainRefused: true,
        durableControllerBarrierBeforeDrain: true,
        inputClosedBeforeAck: true,
        allObservedProcessesGone: true,
      },
      receipt: {
        lifetimeId: receipt.lifetimeId,
        finalWaitResult: receipt.finalWaitResult,
        scope: receipt.scope,
        cleanupAuthorized: receipt.cleanupAuthorized,
      },
      limitations: [
        "Synthetic local controller admission/drain authorization and lease inspection, not installed server receipt ingestion.",
        executionMode === "direct"
          ? "Direct native fixture; namespace denial of outer journal/control capabilities is separately exercised by isolated fixture."
          : "Actual native namespace/controller-key/outer-key/proc-FD denial tested; installed controller barrier and challenge receipt ingestion remain separate gates.",
        "Actual fixed worker shim/private installed configuration startup and installer readiness are not exercised.",
      ],
    };
    const evidenceDirectory = resolve("docs/checks/autonomous-delivery/guardian-local");
    let output = resolve(
      process.env.HIVE_GUARDED_CONTROLLER_EVIDENCE_PATH ??
        join(
          evidenceDirectory,
          executionMode === "direct" ? "controller-native.json" : "controller-native-isolated.json",
        ),
    );
    assert.ok(output.startsWith(`${evidenceDirectory}/`) && output.endsWith(".json"));
    if (process.env.HIVE_GUARDED_CONTROLLER_EVIDENCE_PATH && executionMode === "isolated")
      output = output.replace(/\.json$/, "-isolated.json");
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
  });

test("installed guardian selection requires isolation and cannot silently use the legacy host entry", async () => {
  const config = {
    schemaVersion: 1,
    enabled: true,
    profile: "software",
    binding: {},
    hiveOrigin: "https://hive.example.com",
    issuerPublicKeyPem: "fixture",
    issuerKeyId: "fixture",
    port: 13341,
    model: "gpt-6.1-sol",
    effort: "low",
    managerEnabled: false,
  };
  assert.equal(validateHostConfig({ ...config, guardianEnabled: false }).guardianEnabled, false);
  assert.throws(() => validateHostConfig({ ...config, guardianEnabled: true }));
  assert.throws(() =>
    validateHostConfig({ ...config, guardianEnabled: "true", nativeIsolationEnabled: true }),
  );
  const guarded = { ...config, guardianEnabled: true, nativeIsolationEnabled: true };
  assert.equal(validateHostConfig(guarded).guardianEnabled, true);
  await assert.rejects(startWorkspaceHost(guarded), /host_configuration_or_runtime_rejected/);
  await assert.rejects(
    startWorkspaceHost(config, { guardian: {} }),
    /host_configuration_or_runtime_rejected/,
  );
});

test("startup hash and parsed config come from the same private byte snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "hive-startup-bytes-"));
  try {
    const directory = join(home, ".config/hive");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('{"port":13341}\n');
    writeFileSync(join(directory, "codex-host.json"), bytes, { mode: 0o600 });
    const source = `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';os.userInfo=()=>({homedir:process.argv[1]});syncBuiltinESMExports();const {readInstalledHostStartup}=await import(${JSON.stringify(new URL("../templates/ai-dev-k8s/scripts/codex-workspace-host.mjs", import.meta.url).href)});const first=readInstalledHostStartup();writeFileSync(process.argv[1]+'/.config/hive/codex-host.json','{"port":14441}');process.stdout.write(JSON.stringify({port:first.config.port,digest:first.configSha256,nextPort:readInstalledHostStartup().config.port}));`;
    const result = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", source, home], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      }),
    );
    assert.deepEqual(result, { port: 13341, digest: sha(bytes), nextPort: 14441 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
