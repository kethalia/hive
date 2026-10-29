// Installed-only namespace construction. No request, model or ticket fields are
// accepted as filesystem paths, environment values, mount flags or native RPC.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
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
export function prepareNativeNamespace({ home, stateDirectory, codexExecutable, fixtureProvider }) {
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
    "--bind",
    projects,
    projects,
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
    verificationCwd: projects,
    codexHome,
    tokenPath,
    profile: NATIVE_PROFILE,
    policySha256: digest(requirements),
    command(args, { cwd = nativeHome, holdLock = false } = {}) {
      check(
        cwd === nativeHome || (cwd.startsWith(`${projects}/github/`) && realpathSync(cwd) === cwd),
      );
      return [
        bwrap,
        ...base,
        ...(holdLock ? ["--sync-fd", "3"] : []),
        "--chdir",
        cwd,
        "--",
        codexExecutable,
        ...args,
      ];
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
