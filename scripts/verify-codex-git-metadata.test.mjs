import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  METADATA_READ_ONLY_POLICY_DIGEST,
  NATIVE_PROFILE,
  pinNativeMetadata,
  validateMetadataApproval,
} from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";
import {
  launchNative,
  openSupervisor,
  validateSupervisorConfig,
} from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const pins = (path) => {
  const value = lstatSync(path, { bigint: true });
  return { device: String(value.dev), inode: String(value.ino) };
};
function fixture(t, realHome = false) {
  const home = mkdtempSync(
    join(realHome ? process.cwd() : tmpdir(), realHome ? ".git-ro-" : "hive-git-ro-"),
  );
  const projectsRoot = join(home, "projects/.hive-managed"),
    checkout = join(projectsRoot, "github/123/checkout");
  mkdirSync(checkout, { recursive: true, mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  writeFileSync(join(checkout, "file.txt"), "fixture\n");
  git("add", "file.txt");
  git("commit", "--quiet", "-m", "test: fixture");
  const project = {
    projectId: randomUUID(),
    repositoryId: "123",
    taskId: randomUUID(),
    leaseId: randomUUID(),
    leaseGeneration: 1,
    model: "gpt-6.1-sol",
    effort: "low",
  };
  const approval = {
    runtimeId: randomUUID(),
    runtimeGeneration: 1,
    policyDigest: "a".repeat(64),
    metadataPolicyDigest: METADATA_READ_ONLY_POLICY_DIGEST,
    nativeLaunchId: randomUUID(),
    launchIntentDigest: "b".repeat(64),
    approvals: [
      {
        projectId: project.projectId,
        repositoryId: project.repositoryId,
        taskId: project.taskId,
        leaseId: project.leaseId,
        leaseGeneration: 1,
        checkoutIncarnation: randomUUID(),
        checkoutIdentity: pins(checkout),
        revision: git("rev-parse", "HEAD"),
        admissionId: randomUUID(),
        admissionGeneration: 1,
        firstNative: true,
      },
    ],
  };
  if (!realHome) t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, projectsRoot, checkout, project, approval, git };
}
test("metadata mode requires exact first-native authority, policy and checkout identity", async (t) => {
  const f = fixture(t),
    executable = "/fixture/codex";
  const config = {
    schemaVersion: 1,
    profile: "software",
    ownerId: "owner",
    workspaceId: "workspace",
    buildId: "build",
    codexExecutable: executable,
    codexSha256: "a".repeat(64),
    projects: [f.project],
    executionMode: "isolated",
    metadataReadOnly: true,
  };
  assert.equal(validateSupervisorConfig(config).metadataReadOnly, true);
  assert.throws(() => validateSupervisorConfig({ ...config, executionMode: "direct" }));
  await assert.rejects(openSupervisor(config, { home: f.home }), /metadata_authority_required/);
  assert.deepEqual(validateMetadataApproval(f.approval, [f.project]), f.approval);
  for (const mutate of [
    (v) => {
      v.approvals[0].firstNative = false;
    },
    (v) => {
      v.metadataPolicyDigest = "0".repeat(64);
    },
    (v) => {
      v.approvals[0].leaseId = randomUUID();
    },
    (v) => {
      v.approvals[0].checkoutIdentity.inode = 1;
    },
    (v) => {
      v.extra = true;
    },
  ]) {
    const value = structuredClone(f.approval);
    mutate(value);
    assert.throws(() => validateMetadataApproval(value, [f.project]));
  }
  let calls = 0;
  await assert.rejects(
    openSupervisor(config, {
      home: f.home,
      metadataAuthority: async () => {
        calls++;
        throw new Error("uncertain_reservation");
      },
    }),
    /uncertain_reservation/,
  );
  await assert.rejects(
    openSupervisor(config, {
      home: f.home,
      metadataAuthority: async () => {
        calls++;
        return f.approval;
      },
    }),
    /metadata_launch_reconciliation_required/,
  );
  assert.equal(calls, 1, "uncertain first-native reservation must not be retried");
  await assert.rejects(
    openSupervisor({ ...config, metadataReadOnly: false }, { home: f.home }),
    /metadata_mode_downgrade_rejected/,
  );
});

for (const kind of [
  "symlink",
  "metadata-symlink",
  "gitfile",
  "hardlink",
  "alternates",
  "commondir",
  "worktrees",
  "identity",
  "oversize",
  "entry-limit",
])
  test(`metadata pinning rejects ${kind} before launch`, (t) => {
    const f = fixture(t),
      metadata = join(f.checkout, ".git");
    if (kind === "symlink") symlinkSync("HEAD", join(metadata, "alias"));
    if (kind === "metadata-symlink" || kind === "gitfile") {
      renameSync(metadata, `${metadata}-original`);
      if (kind === "metadata-symlink") symlinkSync(".git-original", metadata);
      else writeFileSync(metadata, "gitdir: .git-original\n");
    }
    if (kind === "hardlink") linkSync(join(metadata, "HEAD"), join(f.checkout, "hardlink"));
    if (kind === "alternates")
      writeFileSync(join(metadata, "objects/info/alternates"), "/outside\n");
    if (kind === "commondir") writeFileSync(join(metadata, "commondir"), "/outside\n");
    if (kind === "worktrees") mkdirSync(join(metadata, "worktrees"));
    if (kind === "identity") f.approval.approvals[0].checkoutIdentity.inode = "0";
    if (kind === "oversize") {
      const path = join(metadata, "huge");
      writeFileSync(path, "");
      truncateSync(path, 268435457);
    }
    if (kind === "entry-limit")
      for (let n = 0; n < 8193; n++) writeFileSync(join(metadata, `fixture-${n}`), "");
    assert.throws(() =>
      pinNativeMetadata({ projectsRoot: f.projectsRoot, approvals: f.approval.approvals }),
    );
  });

test("pinned descriptor mount resists checkout path replacement and consumes inherited handles", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 10000,
}, (t) => {
  const f = fixture(t),
    pinned = pinNativeMetadata({ projectsRoot: f.projectsRoot, approvals: f.approval.approvals });
  t.after(pinned.close);
  const bwrap = realpathSync("/home/coder/.local/bin/bwrap");
  const script = `import os,pathlib,errno\np=pathlib.Path(${JSON.stringify(f.checkout)});assert (p/'file.txt').read_text()=='fixture\\n';(p/'allowed').write_text('ok')\nfor fd in range(64,67):\n try:os.fstat(fd)\n except OSError:continue\n raise AssertionError('fd leaked')\ntry:(p/'.git/HEAD').write_text('bad')\nexcept OSError as e:assert e.errno in (errno.EROFS,errno.EACCES)\nelse:raise AssertionError('metadata write allowed')\nprint('PINNED_ORIGINAL')`;
  const command = pinned.wrap([
    bwrap,
    "--unshare-user",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    ...pinned.mounts,
    "--bind",
    "/proc",
    "/proc",
    "--dev",
    "/dev",
    "/usr/bin/python3",
    "-I",
    "-c",
    script,
  ]);
  // Change the host pathname after command construction, in the exact window a
  // path-only mount would resolve attacker replacement data. FDs retain original.
  renameSync(f.checkout, `${f.checkout}-original`);
  mkdirSync(join(f.checkout, ".git"), { recursive: true });
  writeFileSync(join(f.checkout, "file.txt"), "replacement");
  assert.throws(() => pinned.assert());
  assert.equal(
    execFileSync(command[0], command.slice(1), { encoding: "utf8", timeout: 5000 }).trim(),
    "PINNED_ORIGINAL",
  );
  assert.equal(readFileSync(join(f.checkout, "file.txt"), "utf8"), "replacement");
});

test("actual native root, child, CLI and resumed thread retain read-only Git metadata with live host refs", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 35000,
}, async (t) => {
  const f = fixture(t, true),
    metadata = join(f.checkout, ".git");
  const sourcePaths = [
    "templates/ai-dev-k8s/scripts/codex-native-namespace.mjs",
    "templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
    "templates/ai-dev-k8s/scripts/managed-projects.py",
    "scripts/agents/test_managed_projects.py",
    "scripts/verify-codex-git-metadata.test.mjs",
  ];
  const sourceSha256 = Object.fromEntries(
    sourcePaths.map((path) => [path, sha(readFileSync(path))]),
  );
  const executable = realpathSync(
    process.env.HIVE_TEST_CODEX_EXECUTABLE ||
      "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  const hashBefore = f.git("rev-parse", "HEAD"),
    headBefore = readFileSync(join(metadata, "HEAD"), "utf8");
  symlinkSync(".git", join(f.checkout, "metadata-alias"));
  const nativeConfig = {
    schemaVersion: 1,
    profile: "software",
    ownerId: "owner",
    workspaceId: "workspace",
    buildId: "build",
    codexExecutable: executable,
    codexSha256: sha(readFileSync(executable)),
    projects: [f.project],
    executionMode: "isolated",
    metadataReadOnly: true,
  };
  const events = [],
    served = new Set();
  let rootThreadId,
    native,
    supervisor,
    requests = 0,
    metadataFd;
  const probe = (marker) =>
    `import os,pathlib,errno,json,subprocess\np=pathlib.Path(${JSON.stringify(f.checkout)});g=p/'.git';assert (g/'HEAD').read_text()==${JSON.stringify(headBefore)};denied=[]\ndef attempt(name,fn):\n try:fn()\n except OSError as e:\n  assert e.errno in [errno.EACCES,errno.EPERM,errno.EROFS,errno.EBUSY,errno.EXDEV,errno.ENOENT];denied.append(name);return\n raise AssertionError(name+' allowed')\nattempt('config',lambda:(g/'config').write_text('bad'))\nattempt('refs',lambda:(g/'refs/heads/escape').write_text('bad'))\nattempt('objects',lambda:(g/'objects/escape').write_text('bad'))\nattempt('unlink',lambda:os.unlink(g/'HEAD'))\nattempt('renameGit',lambda:os.rename(g,p/'.git-moved'))\nattempt('renameCheckout',lambda:os.rename(p,p.parent/'checkout-moved'))\nattempt('hardlink',lambda:os.link(g/'HEAD',p/'metadata-hardlink'))\nattempt('symlinkAlias',lambda:(p/'metadata-alias/HEAD').write_text('bad'))\nattempt('workerFd',lambda:open('/proc/${process.pid}/fd/${metadataFd}/HEAD','w'))\nattempt('nativeProcAlias',lambda:open('/proc/${native.processIdentity.pid}/root'+str(g/'HEAD'),'w'))\nsub=subprocess.run(['/usr/bin/unshare','-Urnm','/usr/bin/python3','-I','-c',"import ctypes,sys;raise SystemExit(0 if ctypes.CDLL(None,use_errno=True).mount(None,sys.argv[1].encode(),None,32,None)==0 else 1)",str(g)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);assert sub.returncode!=0;denied.append('nestedNamespace')\n(p/${JSON.stringify(`probe-${marker}.json`)}).write_text(json.dumps({'denied':denied,'worktreeWrite':True}));print('METADATA_DENIED')`;
  const provider = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1048576) req.destroy();
    });
    req.on("end", async () => {
      if (++requests > 24) {
        res.writeHead(429);
        res.end();
        return;
      }
      const body = JSON.parse(raw),
        user = [...(body.input ?? [])].reverse().find((value) => value.role === "user");
      const marker =
        req.headers["x-codex-parent-thread-id"] === rootThreadId && rootThreadId
          ? "META_CHILD"
          : JSON.stringify(user).match(/META_(ROOT|SPAWN|CHILD|RESUME)/)?.[0];
      let item = {
        id: `message_${requests}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "META_DONE", annotations: [] }],
      };
      if (
        marker &&
        !served.has(marker) &&
        !JSON.stringify(user).includes("Generate a concise, single-line task title")
      ) {
        served.add(marker);
        item =
          marker === "META_SPAWN"
            ? {
                id: `fc_${requests}`,
                type: "function_call",
                namespace: "collaboration",
                name: "spawn_agent",
                call_id: `call_${requests}`,
                arguments: JSON.stringify({
                  task_name: "metadata_fixture",
                  message: "META_CHILD",
                  fork_turns: "none",
                  model: "gpt-6.1-sol",
                  reasoning_effort: "low",
                }),
                status: "completed",
              }
            : {
                id: `fc_${requests}`,
                type: "function_call",
                namespace: "functions",
                name: "exec_command",
                call_id: `call_${requests}`,
                arguments: JSON.stringify({
                  cmd: `/usr/bin/python3 -I -c '${probe(marker).replaceAll("'", "'\\''")}'`,
                  login: false,
                  max_output_tokens: 1000,
                }),
                status: "completed",
              };
      }
      if (requests === 1) await delay(1500);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: `response_${requests}`, status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress" },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `response_${requests}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));
  t.after(async () => {
    if (
      process.env.HIVE_GIT_METADATA_EVIDENCE_PATH &&
      !existsSync(resolve(process.env.HIVE_GIT_METADATA_EVIDENCE_PATH))
    )
      writeFileSync(
        resolve(process.env.HIVE_GIT_METADATA_EVIDENCE_PATH),
        `${JSON.stringify({ schemaVersion: 1, status: "failed", requests, nativeCreated: Boolean(native), registryPhase: supervisor?.state.status ?? null, observedMethods: [...new Set(events.map((event) => event.method))] }, null, 2)}\n`,
        { flag: "wx" },
      );
    if (supervisor) await supervisor.close();
    else await native?.close();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    rmSync(f.home, { recursive: true, force: true });
  });
  supervisor = await openSupervisor(nativeConfig, {
    home: f.home,
    metadataAuthority: async ({ projects }) => {
      assert.deepEqual(projects, [f.project]);
      return f.approval;
    },
    runtimeFactory: async (args) => {
      native = await launchNative({
        ...args,
        fixtureProvider: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1` },
      });
      native.inspectLease = () => ({
        ok: true,
        data: {
          status: "ready",
          checkoutVerified: true,
          checkoutDirectory: f.checkout,
          checkoutIdentity: pins(f.checkout),
          checkoutIncarnation: f.approval.approvals[0].checkoutIncarnation,
          revision: hashBefore,
          lease: {
            id: f.project.leaseId,
            taskId: f.project.taskId,
            generation: 1,
            expiresAt: Date.now() / 1000 + 120,
          },
        },
      });
      native.setManagerAdapter({ observe: (event) => events.push(event) });
      return native;
    },
  });
  metadataFd = readdirSync("/proc/self/fd").find((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === metadata;
    } catch {
      return false;
    }
  });
  assert.ok(metadataFd);
  assert.throws(
    () =>
      supervisor.enrollPreparedProject({
        ...f.project,
        projectId: randomUUID(),
        repositoryId: "456",
      }),
    /metadata_inventory_fixed/,
  );
  const created = await supervisor.command({
    operation: "ensureProject",
    projectId: f.project.projectId,
    creationIntentId: randomUUID(),
  });
  rootThreadId = created.threadId;
  const waitTurn = async (threadId, turnId) => {
    for (let n = 0; n < 240; n++) {
      const event = events.find(
        (e) =>
          e.method === "turn/completed" &&
          e.params.threadId === threadId &&
          e.params.turn.id === turnId,
      );
      if (event) {
        assert.equal(event.params.turn.status, "completed");
        return;
      }
      await delay(25);
    }
    assert.fail("metadata fixture turn deadline");
  };
  const run = async (marker) => {
    const { turn } = await native.call("turn/start", {
      threadId: rootThreadId,
      input: [{ type: "text", text: marker, text_elements: [] }],
      permissions: NATIVE_PROFILE,
    });
    await waitTurn(rootThreadId, turn.id);
  };
  await run("META_ROOT");
  for (let n = 0; n < 100 && !existsSync(join(f.checkout, "probe-META_ROOT.json")); n++)
    await delay(25);
  assert.equal(
    JSON.parse(readFileSync(join(f.checkout, "probe-META_ROOT.json"))).denied.length,
    11,
  );
  await supervisor.command({ operation: "refresh", projectId: f.project.projectId });
  await supervisor.command({ operation: "attach", projectId: f.project.projectId });
  let pane = "";
  for (let n = 0; n < 100; n++) {
    pane = execFileSync(
      "/usr/bin/tmux",
      ["-S", join(supervisor.stateDirectory, "tmux.sock"), "capture-pane", "-p"],
      { encoding: "utf8" },
    );
    if (pane.includes("META_DONE")) break;
    await delay(25);
  }
  assert.match(pane, /META_DONE/);
  await run("META_SPAWN");
  for (let n = 0; n < 240 && !existsSync(join(f.checkout, "probe-META_CHILD.json")); n++)
    await delay(25);
  assert.equal(
    JSON.parse(readFileSync(join(f.checkout, "probe-META_CHILD.json"))).denied.length,
    11,
  );
  await native.call("thread/resume", {
    threadId: rootThreadId,
    cwd: f.checkout,
    permissions: NATIVE_PROFILE,
  });
  await run("META_RESUME");
  assert.equal(
    JSON.parse(readFileSync(join(f.checkout, "probe-META_RESUME.json"))).denied.length,
    11,
  );
  const ref = join(metadata, "refs/heads/host-proof"),
    temporary = `${ref}.tmp`;
  writeFileSync(temporary, `${hashBefore}\n`);
  renameSync(temporary, ref);
  const visible = await native.call("command/exec", {
    command: ["/usr/bin/git", "rev-parse", "refs/heads/host-proof"],
    cwd: f.checkout,
    permissionProfile: NATIVE_PROFILE,
  });
  assert.equal(visible.exitCode, 0);
  assert.equal(visible.stdout.trim(), hashBefore);
  const hostileCwd = await native.call("command/exec", {
    command: [
      "/usr/bin/python3",
      "-I",
      "-c",
      `import os,errno\ntry:os.rename(${JSON.stringify(f.checkout)},${JSON.stringify(`${f.checkout}-escaped`)})\nexcept OSError as e:assert e.errno in [errno.EROFS,errno.EPERM,errno.EACCES];print('DENIED')\nelse:raise SystemExit(2)`,
    ],
    cwd: dirname(f.checkout),
    permissionProfile: NATIVE_PROFILE,
  });
  if (hostileCwd.exitCode === 0) assert.equal(hostileCwd.stdout.trim(), "DENIED");
  else {
    assert.equal(hostileCwd.exitCode, 1);
    assert.equal(
      hostileCwd.stderr.trim(),
      `bwrap: Can't mkdir ${dirname(f.checkout)}/.codex: Read-only file system`,
    );
  }
  assert.equal(f.git("rev-parse", "HEAD"), hashBefore);
  assert.equal(readFileSync(join(metadata, "HEAD"), "utf8"), headBefore);
  const childThreadIds = [
    ...new Set(
      events
        .filter(
          (event) => event.method === "turn/started" && event.params.threadId !== rootThreadId,
        )
        .map((event) => event.params.threadId),
    ),
  ];
  assert.equal(childThreadIds.length, 1);
  assert.ok(childThreadIds[0]);
  const result = {
    schemaVersion: 1,
    scope: "Local mock only; no account inference or production authority",
    metadataPolicyDigest: METADATA_READ_ONLY_POLICY_DIGEST,
    threadId: rootThreadId,
    childThreadIds,
    requests,
    rootDenials: 11,
    childDenials: 11,
    resumeDenials: 11,
    cliAttached: true,
    hostAtomicRefVisible: true,
    hostileCwdDenied: true,
    hostileCwdDenial:
      hostileCwd.exitCode === 0 ? "rename_syscall_denied" : "sandbox_setup_read_only_parent",
    fixedInventory: true,
    executionIdentity: native.executionIdentity,
    metadataPins: native.metadataPins,
    nativeSha256: nativeConfig.codexSha256,
    sourceSha256,
    sourceStable: sourcePaths.every((path) => sha(readFileSync(path)) === sourceSha256[path]),
  };
  assert.equal(result.sourceStable, true);
  if (process.env.HIVE_GIT_METADATA_EVIDENCE_PATH)
    writeFileSync(
      resolve(process.env.HIVE_GIT_METADATA_EVIDENCE_PATH),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx" },
    );
});
