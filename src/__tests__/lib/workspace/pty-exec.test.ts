import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelaySocket } from "@/lib/terminal/relay-types";
import { execWorkspacePty } from "@/lib/workspace/pty-exec.server";

// Actual Python wrapper, subprocess pipes and OS PTY; only the Coder metadata /
// WebSocket envelope are fixture seams. This creates no workspace or server.
const harness = `import base64,json,os,pty,select,signal,subprocess,sys
master,slave=pty.openpty()
child=subprocess.Popen(["/bin/bash","-c",sys.argv[1]],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
buffer=b""
try:
    while True:
        ready,_,_=select.select([master,sys.stdin],[],[],0.1)
        if sys.stdin in ready:
            data=os.read(sys.stdin.fileno(),65536)
            if not data: break
            buffer+=data
            while b"\\n" in buffer:
                line,buffer=buffer.split(b"\\n",1)
                os.write(master,json.loads(line)["data"].encode())
        if master in ready:
            try: data=os.read(master,4096)
            except OSError: break
            if not data: break
            print(base64.b64encode(data).decode(),flush=True)
finally:
    child.terminate()
    child.wait(timeout=3)
    os.close(master)
`;
const owner = "10000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8000-000000000001";
const buildId = "30000000-0000-4000-8000-000000000001";
const agentId = "40000000-0000-4000-8000-000000000001";
const origin = "https://coder.example.com";
const options = {
  coderUrl: origin,
  sessionToken: "fixture-private-credential",
  timeoutMs: 5000,
  expected: { workspaceId, buildId, agentId },
};
const closed: Promise<unknown>[] = [];
class PythonSocket implements RelaySocket {
  readyState = 1;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  listeners = new Map<string, Set<(event: never) => void>>();
  child?: ReturnType<typeof spawn>;
  sent: string[] = [];
  constructor(
    readonly command: string,
    readonly transform = (value: Buffer) => value,
  ) {}
  accept() {
    this.child = spawn("python3", ["-u", "-c", harness, this.command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    closed.push(once(this.child, "close"));
    let pending = "";
    this.child.stdout?.on("data", (data) => {
      pending += data.toString();
      while (pending.includes("\n")) {
        const at = pending.indexOf("\n");
        const raw = this.transform(Buffer.from(pending.slice(0, at), "base64"));
        pending = pending.slice(at + 1);
        // Split frames to exercise incremental parsing, including base64 splits.
        for (let offset = 0; offset < raw.length; offset += 137)
          this.emit("message", { data: new Uint8Array(raw.subarray(offset, offset + 137)) });
      }
    });
    this.child.stderr?.resume();
    this.child.on("close", () => this.emit("close"));
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    expect(typeof data).not.toBe("string");
    const line = new TextDecoder().decode(data as Uint8Array);
    this.sent.push(JSON.parse(line).data);
    this.child?.stdin?.write(`${line}\n`);
  }
  close() {
    this.child?.stdin?.end();
  }
  addEventListener(event: string, listener: unknown) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(listener as (event: never) => void);
  }
  removeEventListener(event: string, listener: unknown) {
    this.listeners.get(event)?.delete(listener as (event: never) => void);
  }
  emit(event: string, value: unknown = {}) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value as never);
  }
}
function fixture(
  settings: {
    changed?: boolean;
    wrongOwner?: boolean;
    duplicate?: boolean;
    transform?: (value: Buffer) => Buffer;
    earlyCloses?: number;
    closeAfterPayload?: boolean;
  } = {},
) {
  let reads = 0;
  const sockets: PythonSocket[] = [];
  const urls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    expect(url.origin).toBe(origin);
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Coder-Session-Token")).toBe(options.sessionToken);
    if (url.pathname === "/api/v2/users/me") return Response.json({ id: owner, username: "coder" });
    if (url.pathname === "/api/v2/users/me/workspace/fixture") {
      reads++;
      const agent = { id: agentId, name: "main", status: "connected" };
      return Response.json({
        id: workspaceId,
        name: "fixture",
        owner_id: settings.wrongOwner ? buildId : owner,
        owner_name: "coder",
        latest_build: {
          id: settings.changed && reads > 1 ? workspaceId : buildId,
          status: "running",
          resources: [{ agents: settings.duplicate ? [agent, agent] : [agent] }],
        },
      });
    }
    expect(url.pathname).toBe(`/api/v2/workspaceagents/${agentId}/pty`);
    const socket = new PythonSocket(url.searchParams.get("command") ?? "", settings.transform);
    sockets.push(socket);
    if (sockets.length <= (settings.earlyCloses ?? 0))
      socket.accept = () => queueMicrotask(() => socket.emit("close"));
    if (settings.closeAfterPayload) {
      const nonce = /p="HIVE_EXEC_"\+"([a-f0-9-]+)"/.exec(socket.command)?.[1];
      socket.accept = () =>
        queueMicrotask(() => socket.emit("message", { data: `HIVE_EXEC_${nonce}:READY:\n` }));
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        send(data);
        queueMicrotask(() => socket.emit("close"));
      };
    }
    return { status: 101, webSocket: socket } as unknown as Response;
  });
  return { fetcher, sockets, urls };
}
beforeEach(() => vi.stubEnv("CODER_URL", origin));
afterEach(async () => {
  await Promise.all(closed.splice(0));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("trusted workspace exec over Coder PTY", () => {
  it("retries only an early close before the first payload, with fresh nonce and authorization", async () => {
    const f = fixture({ earlyCloses: 1 });
    expect(await execWorkspacePty("fixture.main", "printf success", options, f.fetcher)).toEqual({
      stdout: "success",
      stderr: "",
      exitCode: 0,
    });
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[0].sent).toHaveLength(0);
    expect(f.sockets[0].command).not.toBe(f.sockets[1].command);
    expect(f.urls.filter((url) => url.endsWith("/users/me"))).toHaveLength(3);
  });
  it("never retries a closure after the first private payload chunk", async () => {
    const f = fixture({ closeAfterPayload: true });
    expect(
      (await execWorkspacePty("fixture.main", "printf mutation", options, f.fetcher)).exitCode,
    ).toBe(1);
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0].sent).toHaveLength(1);
  });
  it("bounds setup retries to one", async () => {
    const f = fixture({ earlyCloses: 2 });
    expect((await execWorkspacePty("fixture.main", "true", options, f.fetcher)).exitCode).toBe(1);
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets.every((socket) => socket.sent.length === 0)).toBe(true);
  });
  it("runs the actual fixed Python program with non-TTY stdin, separate binary-safe output and nonzero exit", async () => {
    const f = fixture();
    const stdin = "private input é\n".repeat(1000);
    const command = `python3 -c 'import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.write("diagnostic\\n"); sys.exit(7)'`;
    expect(
      await execWorkspacePty("coder/fixture.main", command, { ...options, stdin }, f.fetcher),
    ).toEqual({ stdout: stdin, stderr: "diagnostic\n", exitCode: 7 });
    expect(
      f.urls.every((url) => !url.includes("private") && !decodeURIComponent(url).includes(command)),
    ).toBe(true);
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0].sent.filter((line) => line.includes(":RUN:"))).toHaveLength(1);
    expect([...f.sockets[0].listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
  it("returns output larger than terminal replay buffers in bounded sequenced frames", async () => {
    const f = fixture();
    const result = await execWorkspacePty(
      "fixture.main",
      'python3 -c \'print("x"*250000,end="")\'',
      options,
      f.fetcher,
    );
    expect(result).toEqual({ stdout: "x".repeat(250000), stderr: "", exitCode: 0 });
  });
  it.each([
    { wrongOwner: true },
    { duplicate: true },
  ])("denies changed ownership or ambiguous agent before upgrade %#", async (bad) => {
    const f = fixture(bad);
    expect((await execWorkspacePty("fixture.main", "true", options, f.fetcher)).exitCode).toBe(1);
    expect(f.sockets).toHaveLength(0);
  });
  it("holds a changed current build after a command, without retrying the command", async () => {
    const f = fixture({ changed: true });
    expect(
      (await execWorkspacePty("fixture.main", "printf completed", options, f.fetcher)).exitCode,
    ).toBe(1);
    expect(f.sockets).toHaveLength(1);
  });
  it("fails closed without explicit credentials or a mismatched captured tuple", async () => {
    const f = fixture();
    expect((await execWorkspacePty("fixture.main", "true", {}, f.fetcher)).exitCode).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(
      (
        await execWorkspacePty(
          "fixture.main",
          "true",
          { ...options, expected: { ...options.expected, buildId: owner } },
          f.fetcher,
        )
      ).exitCode,
    ).toBe(1);
    expect(f.sockets).toHaveLength(0);
  });
  it("enforces the caller output bound and does not retry a potentially executed mutation", async () => {
    const f = fixture();
    const result = await execWorkspacePty(
      "fixture.main",
      "python3 -c 'print(\"x\"*10000)'",
      { ...options, maxBufferBytes: 100 },
      f.fetcher,
    );
    expect(result.exitCode).toBe(1);
    expect(f.sockets).toHaveLength(1);
  });
  it("bounds the command lifetime and closes the local Python/PTY actors", async () => {
    const f = fixture();
    const result = await execWorkspacePty(
      "fixture.main",
      "sleep 5",
      { ...options, timeoutMs: 300 },
      f.fetcher,
    );
    expect(result.exitCode).toBe(124);
    expect(f.sockets).toHaveLength(1);
  });
  it("does not accept missing output frames as successful complete results", async () => {
    const f = fixture({
      transform: (data) => Buffer.from(data.toString().replace(/:OUT:0:/g, ":OUT:1:")),
    });
    const result = await execWorkspacePty("fixture.main", "printf result", options, f.fetcher);
    expect(result.exitCode).toBe(1);
    expect(f.sockets).toHaveLength(1);
  });
});
