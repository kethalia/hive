// Installed-only namespace construction. No request, model or ticket fields are
// accepted as filesystem paths, environment values, mount flags or native RPC.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { processIdentity, processParentPid } from "./codex-process-identity.mjs";
export const NATIVE_PROFILE = "hive-native-isolated";
export const NATIVE_PINS = Object.freeze({
  "bin/codex": "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5",
  "bin/codex-code-mode-host": "522935d4392ec9674fab60b239b5495992c6a93e4deb65113a216b6f5451ccd4",
  "codex-resources/bwrap": "755c8d6a9b893905a4aabab058bd6c02c453e5e8653adb84fc08e570607f3f36",
  "codex-path/rg": "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
});
const check = (value) => {
  if (!value) throw new Error("native_isolation_rejected");
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const METADATA_READ_ONLY_POLICY = Object.freeze({
  version: 1,
  managedRoot: "read-only-fd",
  checkout: "exact-inventory-read-write-fd",
  metadata: "entire-git-read-only-fd",
  source: "verified-worker-fd-before-userns-consumed-by-bwrap",
  maxEntries: 8192,
  maxBytes: 268435456,
  maxDepth: 32,
  links: "no-symlinks-single-link-regular-files",
  storage: "no-alternates-commondir-gitdir-grafts-worktrees-nested-mounts",
  enrollment: "fixed-first-native-inventory",
});
export const METADATA_READ_ONLY_POLICY_DIGEST = digest(JSON.stringify(METADATA_READ_ONLY_POLICY));
const strict = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
export function validateMetadataApproval(value, projects) {
  check(
    strict(value, [
      "runtimeId",
      "runtimeGeneration",
      "policyDigest",
      "metadataPolicyDigest",
      "nativeLaunchId",
      "launchIntentDigest",
      "approvals",
    ]) &&
      uuid(value.runtimeId) &&
      positive(value.runtimeGeneration) &&
      sha256(value.policyDigest) &&
      value.metadataPolicyDigest === METADATA_READ_ONLY_POLICY_DIGEST &&
      uuid(value.nativeLaunchId) &&
      sha256(value.launchIntentDigest) &&
      Array.isArray(value.approvals) &&
      value.approvals.length === projects.length &&
      projects.length > 0 &&
      projects.length <= 32,
  );
  const seen = new Set();
  for (const approval of value.approvals) {
    check(
      strict(approval, [
        "projectId",
        "repositoryId",
        "taskId",
        "leaseId",
        "leaseGeneration",
        "checkoutIncarnation",
        "checkoutIdentity",
        "revision",
        "admissionId",
        "admissionGeneration",
        "firstNative",
      ]),
    );
    const project = projects.find((p) => p.projectId === approval.projectId);
    check(
      project &&
        !seen.has(project.projectId) &&
        ["projectId", "repositoryId", "taskId", "leaseId", "leaseGeneration"].every(
          (key) => approval[key] === project[key],
        ) &&
        uuid(approval.checkoutIncarnation) &&
        /^[a-f0-9]{40}$/.test(approval.revision) &&
        uuid(approval.admissionId) &&
        positive(approval.admissionGeneration) &&
        approval.firstNative === true &&
        strict(approval.checkoutIdentity, ["device", "inode"]) &&
        Object.values(approval.checkoutIdentity).every(
          (v) => typeof v === "string" && /^[0-9]{1,20}$/.test(v),
        ),
    );
    seen.add(project.projectId);
  }
  return structuredClone(value);
}

// No command chosen by a model reaches this pre-exec helper. It opens ONLY the
// live worker's retained directory descriptors and verifies their kernel pins,
// before entering a user namespace. bwrap consumes these FDs before native exec.
const metadataExec = `import os,sys,json,fcntl\nv=json.loads(sys.argv[1]);p=v['owner'];root='/proc/'+str(p['pid'])\ndef identity():\n raw=open(root+'/stat').read();s=raw[raw.rindex(') ')+2:].split();assert s[0] not in ['Z','X'] and s[19]==p['startTime'];assert open('/proc/sys/kernel/random/boot_id').read().strip()==p['bootId']\nidentity();mapped=[]\nfor e in v['entries']:\n fd=os.open(root+'/fd/'+str(e['fd']),os.O_RDONLY|os.O_DIRECTORY);st=os.fstat(fd);assert str(st.st_dev)==e['device'] and str(st.st_ino)==e['inode'];n=fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,64);os.close(fd);os.set_inheritable(n,True);mapped.append(n)\nidentity();args=[str(mapped[int(a[9:])]) if a.startswith('HIVE_FD::') else a for a in v['command']];os.execv(args[0],args)\n`;

export function pinNativeMetadata({ projectsRoot, approvals }) {
  const descriptors = [],
    pins = [];
  let closed = false,
    entries = 0,
    bytes = 0;
  const close = () => {
    if (!closed) {
      closed = true;
      for (const value of descriptors) closeSync(value.fd);
    }
  };
  const take = (path, expected) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    descriptors.push({ fd, device: String(stat.dev), inode: String(stat.ino) });
    check(
      stat.isDirectory() &&
        stat.uid === BigInt(process.getuid()) &&
        (stat.mode & 0o022n) === 0n &&
        (!expected ||
          (String(stat.dev) === expected.device && String(stat.ino) === expected.inode)),
    );
    return {
      fd,
      descriptor: `HIVE_FD::${descriptors.length - 1}`,
      device: String(stat.dev),
      inode: String(stat.ino),
    };
  };
  const scan = (directory, depth, prefix = "") => {
    check(depth <= METADATA_READ_ONLY_POLICY.maxDepth);
    const stream = opendirSync(`/proc/self/fd/${directory.fd}`, { bufferSize: 32 });
    try {
      for (;;) {
        const entry = stream.readSync();
        if (!entry) break;
        const name = entry.name;
        check(++entries <= METADATA_READ_ONLY_POLICY.maxEntries && ![".", ".."].includes(name));
        const relative = `${prefix}${name}`;
        check(
          !["commondir", "gitdir", "worktrees", "info/grafts"].includes(relative) &&
            !/(?:^|\/)objects\/info\/(?:http-)?alternates$/.test(relative),
        );
        const path = `/proc/self/fd/${directory.fd}/${name}`;
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd, { bigint: true });
          check(
            stat.uid === BigInt(process.getuid()) &&
              (stat.mode & 0o022n) === 0n &&
              String(stat.dev) === directory.device,
          );
          if (stat.isDirectory()) scan({ fd, device: String(stat.dev) }, depth + 1, `${relative}/`);
          else {
            check(stat.isFile() && stat.nlink === 1n);
            bytes += Number(stat.size);
            check(bytes <= METADATA_READ_ONLY_POLICY.maxBytes);
          }
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      stream.closeSync();
    }
  };
  try {
    check(
      Array.isArray(approvals) &&
        approvals.length > 0 &&
        approvals.length <= 32 &&
        realpathSync(projectsRoot) === projectsRoot,
    );
    const root = take(projectsRoot);
    const mounts = ["--ro-bind-fd", root.descriptor, projectsRoot];
    const mountFd = openSync("/proc/self/mountinfo", constants.O_RDONLY);
    const mountBytes = Buffer.alloc(1024 * 1024 + 1);
    let mountSize = 0;
    try {
      while (mountSize < mountBytes.length) {
        const count = readSync(mountFd, mountBytes, mountSize, mountBytes.length - mountSize, null);
        if (!count) break;
        mountSize += count;
      }
    } finally {
      closeSync(mountFd);
    }
    check(mountSize <= 1024 * 1024);
    const mountInfo = mountBytes.subarray(0, mountSize).toString("utf8");
    const mountPaths = mountInfo
      .trim()
      .split("\n")
      .map((line) =>
        line
          .split(" ")[4]
          .replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))),
      );
    for (const approval of approvals) {
      check(/^[1-9][0-9]{0,19}$/.test(approval.repositoryId));
      const checkoutPath = join(projectsRoot, "github", approval.repositoryId, "checkout"),
        metadataPath = join(checkoutPath, ".git");
      check(
        realpathSync(checkoutPath) === checkoutPath &&
          !mountPaths.some((path) => path === checkoutPath || path.startsWith(`${checkoutPath}/`)),
      );
      const checkout = take(
        `/proc/self/fd/${root.fd}/github/${approval.repositoryId}/checkout`,
        approval.checkoutIdentity,
      );
      const metadata = take(`/proc/self/fd/${checkout.fd}/.git`);
      scan(metadata, 0);
      pins.push({
        projectId: approval.projectId,
        checkoutPath,
        metadataPath,
        checkout: { device: checkout.device, inode: checkout.inode },
        metadata: { device: metadata.device, inode: metadata.inode },
      });
      mounts.push(
        "--bind-fd",
        checkout.descriptor,
        checkoutPath,
        "--ro-bind-fd",
        metadata.descriptor,
        metadataPath,
      );
    }
    const owner = processIdentity(process.pid);
    return {
      mounts,
      pins: structuredClone(pins),
      scan: { entries, bytes },
      close,
      assert() {
        check(!closed);
        for (const pin of pins)
          for (const [path, expected] of [
            [pin.checkoutPath, pin.checkout],
            [pin.metadataPath, pin.metadata],
          ]) {
            const stat = lstatSync(path, { bigint: true });
            check(
              stat.isDirectory() &&
                realpathSync(path) === path &&
                String(stat.dev) === expected.device &&
                String(stat.ino) === expected.inode,
            );
          }
      },
      wrap(command) {
        this.assert();
        return [
          "/usr/bin/python3",
          "-I",
          "-c",
          metadataExec,
          JSON.stringify({ owner, entries: descriptors, command }),
        ];
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  check(
    realpathSync(path) === path &&
      stat.isDirectory() &&
      stat.uid === process.getuid() &&
      !(stat.mode & 0o077),
  );
  return path;
}
function writePrivate(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`,
    fd = openSync(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
export function prepareNativeNamespace({
  home,
  stateDirectory,
  codexExecutable,
  fixtureProvider,
  metadataApproval,
}) {
  const vendor = dirname(dirname(codexExecutable));
  for (const [relative, pin] of Object.entries(NATIVE_PINS)) {
    const path = join(vendor, relative),
      stat = lstatSync(path);
    check(
      realpathSync(path) === path &&
        stat.isFile() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o022) &&
        digest(readFileSync(path)) === pin,
    );
  }
  const rgDirectory = join(vendor, "codex-path"),
    rgExecutable = join(rgDirectory, "rg"),
    rgStat = lstatSync(rgDirectory);
  check(
    realpathSync(rgDirectory) === rgDirectory &&
      rgStat.isDirectory() &&
      rgStat.uid === process.getuid() &&
      !(rgStat.mode & 0o022) &&
      JSON.stringify(readdirSync(rgDirectory)) === JSON.stringify(["rg"]),
  );
  const root = privateDirectory(join(home, ".local/share/hive/codex-native"));
  const nativeHome = privateDirectory(join(root, "home")),
    codexHome = privateDirectory(join(root, "codex"));
  const projects = privateDirectory(join(home, "projects/.hive-managed"));
  const policyDirectory = privateDirectory(join(stateDirectory, "native-policy"));
  const policyPath = join(policyDirectory, "requirements.toml"),
    configPath = join(codexHome, "config.toml");
  const denied = [
    join(home, ".local/state/hive"),
    join(home, ".config/hive"),
    join(home, ".local/share/hive/codex-host"),
    root,
    "/proc",
    "/etc/codex",
  ];
  const requirements = `allowed_approval_policies=["never"]\nallowed_sandbox_modes=["read-only","workspace-write"]\nallowed_web_search_modes=["disabled"]\ndefault_permissions="${NATIVE_PROFILE}"\nmcp_servers={}\n[allowed_permission_profiles]\n${NATIVE_PROFILE}=true\n[permissions.filesystem]\ndeny_read=${JSON.stringify(denied)}\n[permissions.${NATIVE_PROFILE}.filesystem]\n":minimal"="read"\n${JSON.stringify(codexExecutable)}="read"\n${JSON.stringify(rgExecutable)}="read"\n[permissions.${NATIVE_PROFILE}.filesystem.":workspace_roots"]\n"."="write"\n[permissions.${NATIVE_PROFILE}.network]\nenabled=false\n[features]\napps=false\nplugins=false\nhooks=false\n`;
  writePrivate(policyPath, requirements);
  let config =
    'approval_policy="never"\nweb_search="disabled"\ncheck_for_update_on_startup=false\n[features]\napps=false\nplugins=false\nhooks=false\nmemories=false\n';
  // Private dependency injection for local mock fixtures only. The installed
  // host does not forward any config, environment or HTTP value into this seam.
  if (fixtureProvider) {
    const url = new URL(fixtureProvider.baseUrl);
    check(
      Object.keys(fixtureProvider).length === 1 &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.pathname === "/v1" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password,
    );
    config = `model_provider="hive_local_fixture"\n${config}\n[model_providers.hive_local_fixture]\nname="Local fixture only"\nbase_url=${JSON.stringify(url.href)}\nwire_api="responses"\nrequires_openai_auth=false\n`;
  }
  writePrivate(configPath, config);
  // Real homes enable native arg0 aliases beneath CODEX_HOME. Those executable
  // aliases would conflict with the managed credential/history deny. Keep that
  // one destination empty and read-only; native uses the pinned vendor fallback.
  const emptyAliases = privateDirectory(join(policyDirectory, "empty-runtime-aliases"));
  check(readdirSync(emptyAliases).length === 0);
  const nativeTmp = join(codexHome, "tmp"),
    aliases = join(nativeTmp, "arg0-linux");
  for (const path of [nativeTmp, aliases]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    check(
      realpathSync(path) === path &&
        stat.isDirectory() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o022),
    );
  }
  const tokenPath = join(stateDirectory, "native-token");
  const bwrap = join(vendor, "codex-resources/bwrap");
  const systemFiles = [
    "/etc/passwd",
    "/etc/group",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/ssl/certs",
    "/etc/ssl/openssl.cnf",
  ]
    .filter(existsSync)
    .flatMap((path) => ["--ro-bind", path, path]);
  const metadata = metadataApproval
    ? pinNativeMetadata({ projectsRoot: projects, approvals: metadataApproval.approvals })
    : null;
  const base = [
    "--unshare-user",
    "--die-with-parent",
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
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/etc",
    ...systemFiles,
    "--ro-bind",
    policyDirectory,
    "/etc/codex",
    "--bind",
    nativeHome,
    nativeHome,
    "--bind",
    codexHome,
    codexHome,
    "--ro-bind",
    configPath,
    configPath,
    "--ro-bind",
    emptyAliases,
    aliases,
    ...(metadata ? metadata.mounts : ["--bind", projects, projects]),
    "--ro-bind",
    vendor,
    vendor,
    "--ro-bind",
    tokenPath,
    tokenPath,
    "--bind",
    "/proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  const env = {
    PATH: `${rgDirectory}:/usr/bin:/bin`,
    HOME: nativeHome,
    CODEX_HOME: codexHome,
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
  };
  return {
    bwrap,
    env,
    nativeHome,
    // Native sandbox setup creates its protected .codex marker beneath cwd.
    // The managed parent is intentionally RO; readiness uses an approved RW
    // checkout while that checkout's entire Git metadata remains a RO submount.
    verificationCwd: metadata ? metadata.pins[0].checkoutPath : projects,
    codexHome,
    tokenPath,
    profile: NATIVE_PROFILE,
    policySha256: digest(requirements),
    metadataPins: metadata
      ? {
          pins: metadata.pins,
          scan: metadata.scan,
          metadataPolicyDigest: METADATA_READ_ONLY_POLICY_DIGEST,
        }
      : null,
    close: () => metadata?.close(),
    command(args, { cwd = nativeHome, holdLock = false } = {}) {
      check(
        cwd === nativeHome || (cwd.startsWith(`${projects}/github/`) && realpathSync(cwd) === cwd),
      );
      const command = [
        bwrap,
        ...base,
        ...(holdLock ? ["--sync-fd", "3"] : []),
        "--chdir",
        cwd,
        "--",
        codexExecutable,
        ...args,
      ];
      return metadata ? metadata.wrap(command) : command;
    },
    attest(wrapperPid, hostPid = process.pid) {
      const wrapper = processIdentity(wrapperPid);
      check(wrapper.executable === bwrap && processParentPid(wrapperPid) === hostPid);
      const children = readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      check(children.length === 1);
      const monitor = processIdentity(children[0]);
      check(monitor.executable === bwrap && processParentPid(monitor.pid) === wrapperPid);
      const nativeChildren = readFileSync(
        `/proc/${monitor.pid}/task/${monitor.pid}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      check(nativeChildren.length === 1);
      const native = processIdentity(nativeChildren[0]);
      check(native.executable === codexExecutable && processParentPid(native.pid) === monitor.pid);
      check(
        JSON.stringify(processIdentity(wrapperPid)) === JSON.stringify(wrapper) &&
          JSON.stringify(processIdentity(monitor.pid)) === JSON.stringify(monitor) &&
          JSON.stringify(processIdentity(native.pid)) === JSON.stringify(native),
      );
      return { mode: "isolated", wrapper, monitor, native, policySha256: digest(requirements) };
    },
    async verify(call, cwd) {
      const { requirements: effective } = await call("configRequirements/read", {});
      check(
        effective?.defaultPermissions === NATIVE_PROFILE &&
          JSON.stringify(effective.allowedPermissionProfiles) ===
            JSON.stringify({ [NATIVE_PROFILE]: true }) &&
          effective.allowedApprovalPolicies?.length === 1 &&
          effective.allowedApprovalPolicies[0] === "never" &&
          effective.allowedSandboxModes?.length === 2 &&
          effective.allowedSandboxModes.includes("read-only") &&
          effective.allowedSandboxModes.includes("workspace-write"),
      );
      const script = `import os,sys\nfor p in sys.argv[1:]:\n try:\n  open(p,'rb').close()\n except (PermissionError,FileNotFoundError):\n  continue\n raise SystemExit(2)\nprint('HIVE_ISOLATION_READY')`;
      const result = await call("command/exec", {
        command: [
          "/usr/bin/python3",
          "-I",
          "-c",
          script,
          tokenPath,
          configPath,
          "/etc/codex/requirements.toml",
          `/proc/${process.pid}/environ`,
        ],
        cwd,
        permissionProfile: NATIVE_PROFILE,
        timeoutMs: 3000,
        outputBytesCap: 1024,
      });
      check(result.exitCode === 0 && result.stdout.trim() === "HIVE_ISOLATION_READY");
    },
  };
}
