import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_EXEC_TIMEOUT_MS } from "@/lib/constants";
import type { RelaySocket } from "@/lib/terminal/relay-types";
import { cancelTerminalBody, terminalBody, terminalFetch } from "@/lib/terminal/transport-io";
import type { ExecOptions, ExecResult } from "./exec";

const MIB = 1024 * 1024;
const INPUT_LIMIT = MIB;
const CHUNK = 2048;
const uuid = z.string().uuid();
const userSchema = z.object({ id: uuid, username: z.string().min(1) });
const agentSchema = z.object({ id: uuid, name: z.string(), status: z.string() });
const workspaceSchema = z.object({
  id: uuid,
  name: z.string(),
  owner_id: uuid,
  owner_name: z.string(),
  latest_build: z.object({
    id: uuid,
    status: z.string(),
    resources: z.array(z.object({ agents: z.array(agentSchema).nullish() })),
  }),
});

// Only this fixed program and an unguessable framing nonce enter the PTY URL.
// Commands, optional stdin (including credentials), and results use acknowledged
// stdin/output frames. Raw terminal mode avoids canonical line truncation/echo.
// The child has pipes, not a terminal, matching the existing SSH exec contract.
const SCRIPT = `import base64,json,os,select,selectors,signal,subprocess,sys,time,tty
p="HIVE_EXEC_"+"__NONCE__"
buffer=bytearray()
child=None
selected=None
def expired(*_):
    raise TimeoutError()
def emit(kind,value=""):
    print(p+":"+kind+":"+str(value),flush=True)
def line(seconds):
    end=time.monotonic()+seconds
    while b"\\n" not in buffer:
        if len(buffer)>4096 or time.monotonic()>=end:
            raise TimeoutError()
        if not select.select([sys.stdin],[],[],max(0,end-time.monotonic()))[0]:
            raise TimeoutError()
        data=os.read(sys.stdin.fileno(),4096)
        if not data:
            raise EOFError()
        buffer.extend(data)
    value,_,rest=buffer.partition(b"\\n")
    buffer[:]=rest
    return value.decode("ascii")
def stop():
    if child is not None:
        try:
            os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=1)
try:
    tty.setraw(sys.stdin.fileno())
    signal.signal(signal.SIGALRM,expired)
    signal.signal(signal.SIGHUP,expired)
    signal.signal(signal.SIGTERM,expired)
    signal.alarm(15)
    emit("READY")
    chunks=[]
    size=0
    while True:
        value=line(10)
        run=p+":RUN:"+str(len(chunks))+":"
        if value.startswith(run):
            remaining=int(value[len(run):])
            if not 1<=remaining<=120000:
                raise ValueError()
            break
        prefix=p+":IN:"+str(len(chunks))+":"
        if not value.startswith(prefix):
            raise ValueError()
        data=base64.b64decode(value[len(prefix):],validate=True)
        if not data or len(data)>2048:
            raise ValueError()
        size+=len(data)
        if size>1048576:
            raise ValueError()
        chunks.append(data)
        emit("ACK",len(chunks)-1)
    request=json.loads(b"".join(chunks))
    if set(request)!={"command","stdin","loginShell","timeoutMs","maxBufferBytes"}:
        raise ValueError()
    if not isinstance(request["command"],str) or not request["command"] or "\\x00" in request["command"] or type(request["loginShell"]) is not bool:
        raise ValueError()
    if type(request["timeoutMs"]) is not int or not 1<=request["timeoutMs"]<=120000 or type(request["maxBufferBytes"]) is not int or not 1<=request["maxBufferBytes"]<=8388608:
        raise ValueError()
    stdin=base64.b64decode(request["stdin"],validate=True)
    duration=min(remaining,request["timeoutMs"])/1000
    limit=time.monotonic()+duration
    signal.setitimer(signal.ITIMER_REAL,duration)
    emit("ADMITTED")
    child=subprocess.Popen(["/bin/bash",*( ["-l"] if request["loginShell"] else []),"-c",request["command"]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    selected=selectors.DefaultSelector()
    selected.register(sys.stdin,selectors.EVENT_READ,"CONTROL")
    for file,kind in [(child.stdout,"OUT"),(child.stderr,"ERR")]:
        os.set_blocking(file.fileno(),False)
        selected.register(file,selectors.EVENT_READ,kind)
    offset=0
    if stdin:
        os.set_blocking(child.stdin.fileno(),False)
        selected.register(child.stdin,selectors.EVENT_WRITE,"IN")
    else:
        child.stdin.close()
    sizes={"OUT":0,"ERR":0}
    sequence=0
    while len(selected.get_map())>1:
        if time.monotonic()>=limit:
            raise TimeoutError()
        for key,_ in selected.select(min(0.1,max(0,limit-time.monotonic()))):
            if key.data=="CONTROL":
                if line(0.1)!=p+":CANCEL:":
                    raise ValueError()
                raise TimeoutError()
            if key.data=="IN":
                try:
                    offset+=os.write(key.fileobj.fileno(),stdin[offset:offset+4096])
                except BrokenPipeError:
                    offset=len(stdin)
                if offset==len(stdin):
                    selected.unregister(key.fileobj)
                    key.fileobj.close()
                continue
            data=os.read(key.fileobj.fileno(),4096)
            if not data:
                selected.unregister(key.fileobj)
                continue
            sizes[key.data]+=len(data)
            if sizes[key.data]>request["maxBufferBytes"]:
                raise ValueError()
            emit(key.data,str(sequence)+":"+base64.b64encode(data).decode("ascii"))
            sequence+=1
    code=child.wait(timeout=max(0.001,limit-time.monotonic()))
    signal.setitimer(signal.ITIMER_REAL,2)
    emit("EXIT",str(sequence)+":"+str(code if code>=0 else 128-code))
    if line(2)!=p+":DONE:":
        raise ValueError()
except Exception:
    stop()
    emit("FAILED")
finally:
    signal.setitimer(signal.ITIMER_REAL,0)
    if selected is not None:
        selected.close()
    if child is not None:
        for file in [child.stdin,child.stdout,child.stderr]:
            file.close()
`;

class SetupClosed extends Error {}

function exchange(
  socket: RelaySocket,
  nonce: string,
  payload: Uint8Array,
  maximum: number,
  signal: AbortSignal,
  deadline: number,
) {
  return new Promise<ExecResult>((resolve, reject) => {
    const prefix = `HIVE_EXEC_${nonce}:`;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const output: Record<"OUT" | "ERR", Buffer[]> = { OUT: [], ERR: [] };
    const sizes = { OUT: 0, ERR: 0 };
    let pending = "",
      wire = 0,
      sequence = 0,
      index = 0,
      offset = 0,
      ready = false,
      running = false,
      admitted = false,
      settled = false;
    const finish = (result?: ExecResult, earlyClose = false) => {
      if (settled) return;
      settled = true;
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", failed);
      signal.removeEventListener("abort", abort);
      result
        ? resolve(result)
        : reject(
            earlyClose && offset === 0
              ? new SetupClosed()
              : new Error("Workspace command unavailable; outcome may be unknown."),
          );
    };
    const failed = () => finish();
    const closed = () => finish(undefined, true);
    const abort = () => {
      // Best-effort remote cancellation; loss of this frame remains bounded by
      // the remote execution deadline and is never permission to retry.
      if (running) {
        try {
          send("CANCEL:");
        } catch {}
      }
      finish();
    };
    const send = (value: string) =>
      socket.send(new TextEncoder().encode(JSON.stringify({ data: `${prefix}${value}\n` })));
    const next = () => {
      if (offset === payload.byteLength) {
        running = true;
        signal.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("deadline");
        send(`RUN:${index}:${remaining}`);
      } else {
        const chunk = payload.subarray(offset, offset + CHUNK);
        offset += chunk.byteLength;
        send(`IN:${index}:${Buffer.from(chunk).toString("base64")}`);
      }
    };
    const frame = (value: string) => {
      if (!value.startsWith(prefix)) {
        if (ready) throw new Error("frame");
        return; // Coder/shell banners preceding our fresh nonce are not results.
      }
      const rest = value.slice(prefix.length);
      if (!ready && rest === "READY:") {
        ready = true;
        next();
      } else if (ready && !running && rest === `ACK:${index}`) {
        index++;
        next();
      } else if (running && !admitted && rest === "ADMITTED:") {
        admitted = true;
      } else if (admitted && /^(OUT|ERR):/.test(rest)) {
        const kind = rest.slice(0, 3) as "OUT" | "ERR",
          fields = rest.slice(4).split(":"),
          encoded = fields[1];
        if (fields.length !== 2 || fields[0] !== String(sequence++)) throw new Error("sequence");
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > 4096 || bytes.toString("base64") !== encoded)
          throw new Error("output");
        sizes[kind] += bytes.length;
        if (sizes[kind] > maximum) throw new Error("limit");
        output[kind].push(bytes);
      } else if (admitted && /^EXIT:[0-9]+:(0|[1-9][0-9]{0,2})$/.test(rest)) {
        const fields = rest.slice(5).split(":");
        if (fields[0] !== String(sequence)) throw new Error("sequence");
        const exitCode = Number(fields[1]);
        if (exitCode > 255) throw new Error("exit");
        send("DONE:");
        finish({
          stdout: Buffer.concat(output.OUT).toString("utf8"),
          stderr: Buffer.concat(output.ERR).toString("utf8"),
          exitCode,
        });
      } else throw new Error("frame");
    };
    const message = ({ data }: { data: unknown }) => {
      try {
        if (signal.aborted) throw new Error("aborted");
        if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
          throw new Error("data");
        wire += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (wire > maximum * 3 + INPUT_LIMIT + 65536) throw new Error("wire");
        pending += typeof data === "string" ? data : decoder.decode(data, { stream: true });
        while (!settled && pending.includes("\n")) {
          const newline = pending.indexOf("\n");
          const value = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          frame(value);
        }
        if (pending.length > 8192) throw new Error("line");
      } catch {
        finish();
      }
    };
    socket.addEventListener("message", message);
    socket.addEventListener("close", closed);
    socket.addEventListener("error", failed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else
      try {
        socket.accept({ allowHalfOpen: true });
      } catch {
        failed();
      }
  });
}

/** Trusted server callers only; never exposes command execution as a browser API. */
export async function execWorkspacePty(
  target: string,
  command: string,
  options: ExecOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<ExecResult> {
  let socket: RelaySocket | undefined;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maximum = options.maxBufferBytes ?? MIB;
  let signal = controller.signal;
  try {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 8 * MIB
    )
      throw new Error("bounds");
    signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    const deadline = Date.now() + timeoutMs;
    const origin = new URL(options.coderUrl ?? "");
    if (
      origin.origin !== options.coderUrl ||
      origin.origin !== process.env.CODER_URL ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      !options.sessionToken ||
      !/^[\x21-\x7e]{1,4096}$/.test(options.sessionToken)
    )
      throw new Error("credentials");
    const match = /^(?:([A-Za-z0-9_-]+)\/)?([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(target);
    if (!match || !command || command.includes("\0")) throw new Error("target");
    const [, owner, workspaceName, agentName] = match;
    const headers = { "Coder-Session-Token": options.sessionToken };
    const json = async (path: string) => {
      const response = await terminalFetch(
        fetcher(new URL(path, origin), {
          headers,
          redirect: "manual",
          credentials: "omit",
          signal,
        }),
        signal,
      );
      if (response.status !== 200 || response.redirected) {
        await cancelTerminalBody(response);
        throw new Error("authorization");
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await terminalBody(response, MIB, signal)),
      );
    };
    const authorize = async () => {
      const results = await Promise.allSettled([
        json("/api/v2/users/me"),
        json(`/api/v2/users/me/workspace/${encodeURIComponent(workspaceName)}`),
      ]);
      if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled")
        throw new Error("authorization");
      const user = userSchema.parse(results[0].value),
        workspace = workspaceSchema.parse(results[1].value);
      const agents = workspace.latest_build.resources
        .flatMap((r) => r.agents ?? [])
        .filter((a) => a.name === agentName);
      if (
        (owner && owner !== user.username) ||
        workspace.owner_id !== user.id ||
        workspace.owner_name !== user.username ||
        workspace.name !== workspaceName ||
        workspace.latest_build.status !== "running" ||
        agents.length !== 1 ||
        agents[0].status !== "connected"
      )
        throw new Error("authorization");
      const binding = {
        ownerId: user.id,
        workspaceId: workspace.id,
        buildId: workspace.latest_build.id,
        agentId: agents[0].id,
      };
      if (
        options.expected &&
        Object.entries(options.expected).some(
          ([key, value]) => binding[key as keyof typeof binding] !== value,
        )
      )
        throw new Error("binding");
      return binding;
    };
    let original: Awaited<ReturnType<typeof authorize>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await authorize();
      if (original && JSON.stringify(before) !== JSON.stringify(original))
        throw new Error("changed");
      original = before;
      signal.throwIfAborted();
      const nonce = randomUUID();
      const url = new URL(`/api/v2/workspaceagents/${before.agentId}/pty`, origin);
      const script = SCRIPT.replace("__NONCE__", nonce);
      // Script is a fixed literal: shell escaping is independent of caller payload.
      url.search = new URLSearchParams({
        reconnect: randomUUID(),
        width: "512",
        height: "128",
        command: `python3 -I -c '${script.replace(/'/g, "'\\''")}'`,
      }).toString();
      const upgrade = fetcher(url, {
        headers: { ...headers, Upgrade: "websocket" },
        redirect: "manual",
        credentials: "omit",
        signal,
      });
      void upgrade.then(
        (r) => {
          if (signal.aborted)
            try {
              (r as Response & { webSocket?: RelaySocket }).webSocket?.close(
                1000,
                "Command closed",
              );
            } catch {}
        },
        () => {},
      );
      const response = await terminalFetch(upgrade, signal);
      socket = (response as Response & { webSocket?: RelaySocket }).webSocket;
      if (response.status !== 101 || response.redirected || !socket) {
        await cancelTerminalBody(response);
        throw new Error("upgrade");
      }
      socket.binaryType = "arraybuffer";
      const payload = Buffer.from(
        JSON.stringify({
          command,
          stdin: Buffer.from(options.stdin ?? "").toString("base64"),
          loginShell: options.loginShell ?? false,
          timeoutMs: Math.max(1, deadline - Date.now()),
          maxBufferBytes: maximum,
        }),
      );
      if (payload.byteLength > INPUT_LIMIT) throw new Error("input_limit");
      let result: ExecResult;
      try {
        result = await exchange(socket, nonce, payload, maximum, signal, deadline);
      } catch (error) {
        // Coder can close a new screen before attachment. Only a close before the
        // first payload byte permits one fresh setup; mutations are never replayed.
        if (error instanceof SetupClosed && attempt === 0 && !signal.aborted) {
          socket.close(1000, "Setup closed");
          continue;
        }
        throw error;
      }
      const after = await authorize();
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("changed");
      signal.throwIfAborted();
      return result;
    }
    throw new Error("setup");
  } catch {
    return {
      stdout: "",
      stderr: signal.aborted
        ? "Workspace command deadline or cancellation; outcome may be unknown."
        : "Workspace command unavailable; outcome may be unknown.",
      exitCode: signal.aborted ? 124 : 1,
    };
  } finally {
    controller.abort();
    try {
      socket?.close(1000, "Command closed");
    } catch {
      /* Already closed. */
    }
  }
}
