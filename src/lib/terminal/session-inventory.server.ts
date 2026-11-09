import { randomUUID } from "node:crypto";
import type { SessionData } from "@hive/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { filterGenericTmuxSessions, parseTmuxSessions } from "@/lib/workspaces/sessions";
import {
  authorizeOwnedWorkspacePty,
  type GenericTerminalEnvironment,
} from "../../../deploy/cloudflare/app/generic-terminal-runtime";
import type { RelaySocket } from "./relay-types";
import { cancelTerminalBody, terminalFetch } from "./transport-io";

const TIMEOUT_MS = 8000;
const MAX_WIRE_BYTES = 131072;
const MAX_OUTPUT_BYTES = 32768;
const unavailable = () => new Error("Could not list workspace terminal sessions.");
const resultSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    stdout: z.string().max(MAX_OUTPUT_BYTES),
    stderr: z.string().max(MAX_OUTPUT_BYTES),
  })
  .strict();

// Fixed read-only command, independent of installed Hive helpers. The first
// handshake keeps short-lived screen PTYs alive until attachment. The second
// keeps the completed result available until received, with a bounded wait.
const SCRIPT = `import base64,json,os,select,selectors,signal,subprocess,sys,termios,time
prefix = "HIVE_INVENTORY_" + "__NONCE__"
def expired(*_):
    raise TimeoutError()
signal.signal(signal.SIGALRM, expired)
signal.alarm(8)
def control(kind):
    return bool(select.select([sys.stdin], [], [], 2)[0]) and sys.stdin.readline(128).strip() == prefix + "_" + kind
try:
    attributes = termios.tcgetattr(sys.stdin.fileno())
    attributes[3] &= ~termios.ECHO
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, attributes)
    print(prefix + "_READY", flush=True)
    if not control("GO"):
        raise TimeoutError()
    child = subprocess.Popen(["/usr/bin/tmux", "-L", "web", "list-sessions", "-F", "#{session_name}:#{session_created}:#{session_windows}"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selected = selectors.DefaultSelector()
    outputs = {"stdout":bytearray(), "stderr":bytearray()}
    limit = time.monotonic() + 4
    try:
        selected.register(child.stdout, selectors.EVENT_READ, "stdout")
        selected.register(child.stderr, selectors.EVENT_READ, "stderr")
        while selected.get_map():
            if time.monotonic() >= limit:
                raise TimeoutError()
            for key,_ in selected.select(min(0.1, max(0, limit-time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 4096)
                if not data:
                    selected.unregister(key.fileobj)
                    continue
                outputs[key.data].extend(data)
                if sum(map(len, outputs.values())) > 32768:
                    raise ValueError()
        code = child.wait(timeout=max(0.01, limit-time.monotonic()))
    finally:
        selected.close()
        if child.poll() is None:
            child.kill()
        child.wait(timeout=1)
        child.stdout.close()
        child.stderr.close()
    payload = json.dumps({"exitCode":code,"stdout":outputs["stdout"].decode("utf-8"),"stderr":outputs["stderr"].decode("utf-8")}, separators=(",",":")).encode()
    encoded = base64.b64encode(payload).decode()
    if len(encoded) > 49152:
        raise ValueError()
    print(prefix + "_RESULT", flush=True)
    print(encoded, flush=True)
    print(prefix + "_END", flush=True)
    control("ACK")
except Exception:
    print(prefix + "_FAILED", flush=True)
`;

function projectResult(value: z.infer<typeof resultSchema>) {
  if (Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > MAX_OUTPUT_BYTES)
    throw unavailable();
  if (value.exitCode !== 0) {
    const diagnostic = [value.stderr, value.stdout]
      .map((v) => v.trim())
      .filter(Boolean)
      .join("\n");
    if (
      /^no server running on \/[^\r\n]+$/.test(diagnostic) ||
      (value.exitCode === 1 &&
        /^error connecting to \/[^\r\n]+\/web \(No such file or directory\)$/.test(diagnostic))
    )
      return [];
    throw unavailable();
  }
  const lines = value.stdout.trim() ? value.stdout.trim().split("\n") : [];
  if (lines.length > 1024) throw unavailable();
  const names = new Set<string>();
  for (const line of lines) {
    const match = /^([A-Za-z0-9._-]{1,200}):([0-9]+):([0-9]+)$/.exec(line.trim());
    if (
      !match ||
      names.has(match[1]) ||
      !Number.isSafeInteger(Number(match[2])) ||
      !Number.isSafeInteger(Number(match[3])) ||
      Number(match[3]) < 1
    )
      throw unavailable();
    names.add(match[1]);
  }
  return filterGenericTmuxSessions(parseTmuxSessions(value.stdout));
}

function receive(socket: RelaySocket, nonce: string, signal: AbortSignal) {
  return new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
    const prefix = `HIVE_INVENTORY_${nonce}`;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let raw = "",
      bytes = 0,
      sent = false,
      settled = false;
    const finish = (value?: z.infer<typeof resultSchema>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", failed);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", failed);
      socket.removeEventListener("error", failed);
      if (value) resolve(value);
      else reject(unavailable());
    };
    const failed = () => finish();
    const message = (event: { data: unknown }) => {
      try {
        const data = event.data;
        if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
          throw unavailable();
        bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (bytes > MAX_WIRE_BYTES) throw unavailable();
        raw += typeof data === "string" ? data : decoder.decode(data, { stream: true });
        const text = raw
          // biome-ignore lint/suspicious/noControlCharactersInRegex: PTY output contains OSC terminal sequences.
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: PTY output contains CSI terminal sequences.
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/\r/g, "");
        if (text.includes(`${prefix}_FAILED`)) throw unavailable();
        if (!sent && text.includes(`${prefix}_READY\n`)) {
          sent = true;
          socket.send(new TextEncoder().encode(JSON.stringify({ data: `${prefix}_GO\n` })));
        }
        const begin = `${prefix}_RESULT\n`,
          end = `\n${prefix}_END`;
        const start = text.indexOf(begin),
          stop = text.indexOf(end, start);
        if (start === -1 || stop === -1) return;
        if (!sent || text.indexOf(begin, start + begin.length) !== -1) throw unavailable();
        const encoded = text.slice(start + begin.length, stop).replace(/\s/g, "");
        if (!encoded || encoded.length > 49152 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
          throw unavailable();
        const payload = Buffer.from(encoded, "base64");
        if (payload.toString("base64") !== encoded) throw unavailable();
        const result = resultSchema.parse(JSON.parse(decoder.decode(payload)));
        socket.send(new TextEncoder().encode(JSON.stringify({ data: `${prefix}_ACK\n` })));
        finish(result);
      } catch {
        finish();
      }
    };
    socket.addEventListener("message", message);
    socket.addEventListener("close", failed);
    socket.addEventListener("error", failed);
    signal.addEventListener("abort", failed, { once: true });
    if (signal.aborted) failed();
    else {
      try {
        socket.accept({ allowHalfOpen: true });
      } catch {
        failed();
      }
    }
  });
}

/** Internal read admission. Neither commands nor reconnect identifiers come from the browser. */
export async function readWorkspaceSessionInventory(
  session: SessionData,
  workspaceId: string,
  options: { env?: GenericTerminalEnvironment; fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  const env = options.env ?? (getCloudflareContext().env as GenericTerminalEnvironment);
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  let socket: RelaySocket | undefined;
  try {
    const original = await authorizeOwnedWorkspacePty(
      session.session.sessionId,
      env,
      workspaceId,
      undefined,
      signal,
      fetcher,
    );
    if (
      original.userId !== session.user.id ||
      original.coderUserId !== session.user.coderUserId ||
      original.coderOrigin !== session.user.coderUrl ||
      original.expiresAt <= Date.now()
    )
      throw unavailable();
    const remaining = Math.min(TIMEOUT_MS, original.expiresAt - Date.now());
    if (remaining <= 0) throw unavailable();
    const live = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    const nonce = randomUUID();
    const command = `python3 -I -c '${SCRIPT.replace("__NONCE__", nonce)}'`;
    const url = new URL(`/api/v2/workspaceagents/${original.agentId}/pty`, original.coderOrigin);
    url.search = new URLSearchParams({
      reconnect: randomUUID(),
      width: "512",
      height: "128",
      command,
    }).toString();
    const work = fetcher(url, {
      redirect: "manual",
      credentials: "omit",
      signal: live,
      headers: { Upgrade: "websocket", "Coder-Session-Token": original.token },
    });
    void work.then(
      (late) => {
        if (!live.aborted) return;
        const pending = (late as Response & { webSocket?: RelaySocket }).webSocket;
        try {
          pending?.accept({ allowHalfOpen: true });
          pending?.close(1008, "Inventory expired");
        } catch {}
      },
      () => {},
    );
    const response = await terminalFetch(work, live);
    socket = (response as Response & { webSocket?: RelaySocket }).webSocket;
    if (response.status !== 101 || response.redirected || !socket) {
      await cancelTerminalBody(response);
      throw unavailable();
    }
    socket.binaryType = "arraybuffer";
    const result = await receive(socket, nonce, live);
    const current = await authorizeOwnedWorkspacePty(
      session.session.sessionId,
      env,
      workspaceId,
      original.agentId,
      live,
      fetcher,
    );
    live.throwIfAborted();
    if (
      current.userId !== original.userId ||
      current.coderUserId !== original.coderUserId ||
      current.coderOrigin !== original.coderOrigin ||
      current.buildId !== original.buildId ||
      current.agentId !== original.agentId ||
      current.expiresAt <= Date.now()
    )
      throw unavailable();
    return projectResult(result);
  } catch {
    throw unavailable();
  } finally {
    controller.abort();
    try {
      socket?.close(1000, "Inventory complete");
    } catch {}
  }
}
