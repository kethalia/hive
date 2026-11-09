import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { acquireManagedAuthLock } from "../../templates/ai-dev-k8s/scripts/codex-managed-auth-lock.mjs";

const SHA = "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5";
const MAX_AGE = 10 * 60_000;
const reject = () => {
  throw Error("managed_auth_unavailable");
};
/** No model/thread methods are exposed. This process has exactly the pinned
 * managed credential root, and never inherits the user's provider credentials. */
export async function openAccountSession(home, fd, notify) {
  const executable = join(
    home,
    ".local/share/hive/codex-runtime/0.165.0-linux-x64-c06a67fd8ac76508/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  if (realpathSync(executable) !== executable) reject();
  const info = lstatSync(executable);
  if (
    !info.isFile() ||
    info.uid !== process.getuid() ||
    info.mode & 0o022 ||
    info.size > 512 * 1024 * 1024
  )
    reject();
  const handle = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (createHash("sha256").update(readFileSync(handle)).digest("hex") !== SHA) reject();
  } finally {
    closeSync(handle);
  }
  const root = join(home, ".local/share/hive/codex-native/codex");
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const s = lstatSync(root);
  if (
    realpathSync(root) !== root ||
    !s.isDirectory() ||
    s.uid !== process.getuid() ||
    s.mode & 0o077
  )
    reject();
  const guardian =
    "import ctypes,os,signal,sys\np=int(sys.argv[1])\nr=ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)\nif r!=0 or os.getppid()!=p: sys.exit(1)\nos.execv(sys.argv[2],sys.argv[2:])";
  const child = spawn(
    "/usr/bin/python3",
    ["-c", guardian, String(process.pid), executable, "app-server", "--listen", "stdio://"],
    {
      env: { HOME: home, CODEX_HOME: root, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      cwd: home,
      stdio: ["pipe", "pipe", "ignore", fd],
    },
  );
  const { call, close, initialized: ready } = createAccountWire(child, notify);
  try {
    const initialized = await call("initialize", {
      clientInfo: { name: "hive_managed_accounts", version: "1" },
    });
    if (
      typeof initialized?.userAgent !== "string" ||
      !/^[^/\s]+\/0\.165\.0(?:\s|$)/.test(initialized.userAgent)
    )
      reject();
    ready();
    return { call, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function createAccountWire(child, notify, { codeInput = false } = {}) {
  let sequence = 0,
    buffer = "",
    ended = false;
  const requests = new Map();
  const closed = new Promise((resolve) => child.once("close", resolve));
  const fail = () => {
    ended = true;
    for (const p of requests.values()) {
      clearTimeout(p.timer);
      p.reject(Error("managed_auth_unavailable"));
    }
    requests.clear();
  };
  child.once("error", fail);
  child.once("close", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > 65536) {
      child.kill("SIGKILL");
      fail();
      return;
    }
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          const p = requests.get(message.id);
          if (!p) continue;
          requests.delete(message.id);
          clearTimeout(p.timer);
          if (message.error) p.reject(Error("managed_auth_unavailable"));
          else p.resolve(message.result);
        } else if (["account/login/completed", "account/updated"].includes(message.method))
          notify(message);
      } catch {
        child.kill("SIGKILL");
        fail();
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, rejectCall) => {
      if (
        ended ||
        ![
          "initialize",
          "account/read",
          "account/login/start",
          "account/login/cancel",
          "account/logout",
          ...(codeInput ? ["account/login/submitCode"] : []),
        ].includes(method) ||
        requests.size >= 4
      )
        return rejectCall(Error("managed_auth_unavailable"));
      const id = ++sequence,
        timer = setTimeout(() => {
          requests.delete(id);
          rejectCall(Error("managed_auth_unavailable"));
        }, 8000);
      requests.set(id, { resolve, reject: rejectCall, timer });
      child.stdin.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  const close = async () => {
    if (!ended) child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    await closed;
    clearTimeout(kill);
    fail();
  };
  return {
    call,
    close,
    initialized: () => child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`),
  };
}

export function createCodexAccountManager(options) {
  return createAccountManager({ ...options, provider: "codex" });
}

export function createAccountManager({
  provider = "codex",
  home,
  lifetimeId,
  profile,
  open = openAccountSession,
  acquire = acquireManagedAuthLock,
  now = Date.now,
}) {
  let generation = 0,
    pending = null,
    session = null,
    lock = null,
    timer,
    closed = false,
    state = "unknown",
    queue = Promise.resolve();
  let sessionEpoch = 0;
  const notifications = new Map();
  const view = () => ({
    scope: provider === "codex" ? "managed-native" : "workspace-cli",
    lifetimeId,
    generation,
    state,
    pending:
      state === "pending" && pending
        ? {
            verificationUrl: pending.verificationUrl,
            ...(provider === "codex"
              ? { userCode: pending.userCode }
              : { codeSubmitted: pending.codeSubmitted }),
            expiresAt: pending.expiresAt,
          }
        : null,
  });
  const stop = async (release = true) => {
    clearTimeout(timer);
    sessionEpoch++;
    notifications.clear();
    pending = null;
    const current = session;
    session = null;
    try {
      await current?.close();
    } finally {
      if (release) {
        lock?.close();
        lock = null;
      }
    }
  };
  const start = async () => {
    if (session) return;
    try {
      lock = acquire(home);
    } catch {
      state = "busy";
      return;
    }
    try {
      const epoch = ++sessionEpoch;
      session = await open(home, lock.fd, (message) => {
        if (
          epoch !== sessionEpoch ||
          message.method !== "account/login/completed" ||
          typeof message.params?.loginId !== "string" ||
          typeof message.params?.success !== "boolean" ||
          notifications.size >= 4
        )
          return;
        notifications.set(message.params.loginId, message.params.success);
      });
    } catch (error) {
      lock.close();
      lock = null;
      throw error;
    }
  };
  const settledAccount = async () => {
    // A cancelled/expired process must have exited before durable credential
    // readback. Keep the native fence across close and the fresh read process.
    await stop(false);
    session = await open(home, lock.fd, () => {});
    try {
      return await account();
    } finally {
      await stop();
    }
  };
  const account = async () => {
    const value = await session.call("account/read", { refreshToken: false });
    if (!value || !Object.hasOwn(value, "account")) reject();
    if (value.account === null) return "signed-out";
    if (value.account.type !== (provider === "codex" ? "chatgpt" : "claude")) return "unknown";
    return "signed-in";
  };
  const execute = async (request) => {
    if (
      closed ||
      !["codex", "claude"].includes(provider) ||
      (provider === "codex" && profile !== "software")
    )
      reject();
    if (
      request.action !== "status" &&
      (request.lifetimeId !== lifetimeId || request.generation !== generation)
    ) {
      if (
        request.action === "connect" &&
        request.lifetimeId === lifetimeId &&
        pending?.priorGeneration === request.generation
      )
        return view();
      throw Error("managed_auth_stale");
    }
    if (request.action === "status" && pending) {
      // Poll the exact managed process; no force-refresh is requested.
      if (now() >= pending.expiresAt) {
        generation++;
        state = "expired";
        await stop();
        return view();
      }
      await account();
      if (notifications.has(pending.loginId)) {
        const success = notifications.get(pending.loginId);
        generation++;
        // Completion may follow the stale read response in the same transport
        // callback. Only a subsequent official read can settle saved credentials.
        state = success ? await account() : "failed";
        await stop();
      }
      return view();
    }
    if (request.action === "code") {
      if (
        provider !== "claude" ||
        !pending ||
        pending.codeSubmitted ||
        typeof request.code !== "string" ||
        !/^[!-~]{1,2048}$/.test(request.code)
      )
        throw Error("managed_auth_stale");
      pending.codeSubmitted = true;
      generation++;
      const accepted = await session.call("account/login/submitCode", {
        loginId: pending.loginId,
        code: request.code,
      });
      if (accepted?.accepted !== true) reject();
      return view();
    }
    if (request.action === "connect" && pending) return view();
    if (request.action === "cancel") {
      if (!pending || !session) return view();
      const result = await session.call("account/login/cancel", { loginId: pending.loginId });
      if (!["canceled", "notFound"].includes(result?.status)) reject();
      generation++;
      state = await settledAccount();
      if (state === "signed-out") state = "cancelled";
      return view();
    }
    if (pending) {
      const result = await session.call("account/login/cancel", { loginId: pending.loginId });
      if (!["canceled", "notFound"].includes(result?.status)) reject();
      generation++;
      await stop();
    }
    await start();
    if (!session) return view();
    if (request.action === "status") {
      try {
        state = await account();
      } finally {
        await stop();
      }
      return view();
    }
    if (request.action === "disconnect") {
      await session.call("account/logout");
      generation++;
      state = await settledAccount();
      return view();
    }
    const priorGeneration = generation;
    const result = await session.call("account/login/start", {
      type: provider === "codex" ? "chatgptDeviceCode" : "claudeCli",
    });
    if (
      result?.type !== (provider === "codex" ? "chatgptDeviceCode" : "claudeCli") ||
      typeof result.loginId !== "string" ||
      result.loginId.length > 200 ||
      (provider === "codex"
        ? result.verificationUrl !== "https://auth.openai.com/codex/device" ||
          !/^[A-Z0-9-]{4,32}$/.test(result.userCode)
        : !validClaudeLoginUrl(result.verificationUrl))
    )
      reject();
    generation++;
    state = "pending";
    pending = {
      loginId: result.loginId,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
      codeSubmitted: false,
      expiresAt: now() + MAX_AGE,
      priorGeneration,
    };
    timer = setTimeout(() => {
      void run({ action: "status" }).catch(() => {});
    }, MAX_AGE);
    return view();
  };
  const run = (request) => {
    const result = queue
      .then(() => execute(request))
      .catch(async (error) => {
        if (error.message === "managed_auth_stale") throw error;
        generation++;
        state = "unknown";
        await stop();
        reject();
      });
    queue = result.catch(() => {});
    return result;
  };
  return {
    async peek() {
      await queue;
      return structuredClone(view());
    }, // No process/lock/account read or refresh.
    run,
    async close() {
      closed = true;
      await queue;
      await stop();
    },
  };
}

export function validClaudeLoginUrl(value) {
  try {
    const u = new URL(value);
    return (
      typeof value === "string" &&
      value.length <= 8192 &&
      u.protocol === "https:" &&
      u.host === "claude.com" &&
      u.pathname === "/cai/oauth/authorize" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !!u.search
    );
  } catch {
    return false;
  }
}
