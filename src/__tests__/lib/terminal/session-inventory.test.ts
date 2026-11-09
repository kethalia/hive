import { spawnSync } from "node:child_process";
import type { SessionData } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelaySocket } from "@/lib/terminal/relay-types";
import { readWorkspaceSessionInventory } from "@/lib/terminal/session-inventory.server";
import { authorizeOwnedWorkspacePty } from "../../../../deploy/cloudflare/app/generic-terminal-runtime";

vi.mock("../../../../deploy/cloudflare/app/generic-terminal-runtime", () => ({
  authorizeOwnedWorkspacePty: vi.fn(),
}));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn() }));

const session: SessionData = {
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    coderUserId: "20000000-0000-4000-8000-000000000001",
    coderUrl: "https://coder.example.com",
    username: "fixture",
    email: "fixture@example.com",
  },
  session: { id: "row", sessionId: "session", expiresAt: new Date("2030-01-01") },
};
const workspaceId = "30000000-0000-4000-8000-000000000001";
const agentId = "40000000-0000-4000-8000-000000000001";
const buildId = "50000000-0000-4000-8000-000000000001";
const authorize = vi.mocked(authorizeOwnedWorkspacePty);
const authority = () => ({
  sessionId: session.session.sessionId,
  agentId,
  buildId,
  userId: session.user.id,
  coderUserId: session.user.coderUserId,
  coderOrigin: session.user.coderUrl,
  token: "synthetic-fixture-token",
  expiresAt: Date.now() + 60000,
});

class FixtureSocket implements RelaySocket {
  readyState = 1;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  sent: string[] = [];
  frames: Uint8Array[] = [];
  closes: number[] = [];
  listeners = new Map<string, Set<unknown>>();
  prefix = "";
  result: unknown = {
    exitCode: 0,
    stdout: "existing:1700000000:2\ngit-clone-hidden:1700000001:1\n",
    stderr: "",
  };
  onGo = () => this.reply();
  accept() {
    queueMicrotask(() => this.emit("message", { data: `${this.prefix}_READY\r\n` }));
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (!(data instanceof Uint8Array)) throw Error("Coder requires binary PTY input");
    this.frames.push(data);
    const input = JSON.parse(new TextDecoder().decode(data)).data;
    this.sent.push(input);
    if (input === `${this.prefix}_GO\n`) queueMicrotask(() => this.onGo());
  }
  close(code = 1000) {
    this.closes.push(code);
  }
  addEventListener(event: string, listener: unknown) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  removeEventListener(event: string, listener: unknown) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, value = {}) {
    for (const listener of [...(this.listeners.get(event) ?? [])])
      if (typeof listener === "function") listener(value);
  }
  frame() {
    const data = Buffer.from(JSON.stringify(this.result)).toString("base64");
    return `${this.prefix}_RESULT\n${data}\n${this.prefix}_END\n`;
  }
  reply() {
    const bytes = new TextEncoder().encode(`\x1b[0m${this.frame().replace(/\n/g, "\r\n")}`);
    // Real PTY frames can split UTF-8/control sequences and the result envelope.
    for (let i = 0; i < bytes.length; i += 17)
      this.emit("message", { data: bytes.slice(i, i + 17).buffer });
  }
}

function fixture() {
  const socket = new FixtureSocket();
  let command = "";
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    command = url.searchParams.get("command")!;
    const nonce = /prefix = "HIVE_INVENTORY_" \+ "([a-f0-9-]+)"/.exec(command)![1];
    socket.prefix = `HIVE_INVENTORY_${nonce}`;
    expect(url.origin).toBe(session.user.coderUrl);
    expect(url.pathname).toBe(`/api/v2/workspaceagents/${agentId}/pty`);
    expect(new Headers(init?.headers).get("Coder-Session-Token")).toBe("synthetic-fixture-token");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    return { status: 101, redirected: false, webSocket: socket } as unknown as Response;
  });
  const options = { env: { CODER_URL: session.user.coderUrl }, fetch: fetcher };
  return { socket, fetcher, options, command: () => command };
}

beforeEach(() => {
  authorize.mockImplementation(async () => authority());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fixed Coder PTY session inventory", () => {
  it("lists existing web sessions without starting/attaching tmux sessions or audio", async () => {
    const f = fixture();
    expect(await readWorkspaceSessionInventory(session, workspaceId, f.options)).toEqual([
      { name: "existing", created: 1700000000, windows: 2 },
    ]);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls[1][3]).toBe(agentId);
    expect(f.command()).toContain('["/usr/bin/tmux", "-L", "web", "list-sessions"');
    expect(f.command()).not.toContain("new-session");
    expect(f.command()).not.toContain("hive-audio");
    expect(f.socket.sent).toEqual([`${f.socket.prefix}_GO\n`, `${f.socket.prefix}_ACK\n`]);
    expect(f.socket.frames).toHaveLength(2);
    expect(f.socket.frames.every((frame) => frame instanceof Uint8Array)).toBe(true);
    expect(() => f.socket.send(JSON.stringify({ data: "text-frame" }))).toThrow(
      "Coder requires binary PTY input",
    );
    expect(f.socket.closes).toEqual([1000]);
    expect([...f.socket.listeners.values()].every((value) => value.size === 0)).toBe(true);
  });

  it.each([
    "no server running on /tmp/tmux-1000/web\n",
    "error connecting to /tmp/tmux-1000/web (No such file or directory)\n",
  ])("returns empty only for the recognized missing web-server result %s", async (stderr) => {
    const f = fixture();
    f.socket.result = { exitCode: 1, stdout: "", stderr };
    expect(await readWorkspaceSessionInventory(session, workspaceId, f.options)).toEqual([]);
  });

  it.each([
    { exitCode: 127, stdout: "", stderr: "tmux: command not found" },
    { exitCode: 1, stdout: "", stderr: "permission denied" },
    { exitCode: 0, stdout: "valid:1:1\ninvalid row\n", stderr: "" },
    { exitCode: 0, stdout: "duplicate:1:1\nduplicate:2:1\n", stderr: "" },
    { exitCode: 0, stdout: "invalid:1:0\n", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "", extra: true },
  ])("holds invalid or failed snapshots without exposing diagnostics %#", async (result) => {
    const f = fixture();
    f.socket.result = result;
    await expect(readWorkspaceSessionInventory(session, workspaceId, f.options)).rejects.toThrow(
      "Could not list workspace terminal sessions.",
    );
  });

  it.each([
    "close",
    "error",
    "malformed",
    "oversize",
    "failed",
  ])("fails closed on %s before complete result", async (kind) => {
    const f = fixture();
    f.socket.onGo = () => {
      if (kind === "close" || kind === "error") f.socket.emit(kind);
      else
        f.socket.emit("message", {
          data:
            kind === "malformed"
              ? `${f.socket.prefix}_RESULT\n%%\n${f.socket.prefix}_END\n`
              : kind === "failed"
                ? `${f.socket.prefix}_FAILED\n`
                : "x".repeat(131073),
        });
    };
    await expect(readWorkspaceSessionInventory(session, workspaceId, f.options)).rejects.toThrow();
    expect(f.socket.sent).toHaveLength(1);
    expect(f.socket.closes).toEqual([1000]);
  });

  it("caps long-lived credential timers to the existing read deadline", async () => {
    const f = fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    authorize.mockResolvedValue({
      ...authority(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    await readWorkspaceSessionInventory(session, workspaceId, f.options);
    expect(timeout.mock.calls.every(([duration]) => duration > 0 && duration <= 8000)).toBe(true);
  });

  it("reauthorizes the same subject/current build and rejects a rebuild during the read", async () => {
    const f = fixture();
    authorize
      .mockResolvedValueOnce(authority())
      .mockResolvedValueOnce({ ...authority(), buildId: "60000000-0000-4000-8000-000000000001" });
    await expect(readWorkspaceSessionInventory(session, workspaceId, f.options)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.socket.closes).toEqual([1000]);
  });

  it.each(["foreign", "disconnected"])("does not open a PTY for %s authority", async (kind) => {
    const f = fixture();
    if (kind === "foreign") authorize.mockResolvedValueOnce({ ...authority(), userId: "foreign" });
    else authorize.mockRejectedValueOnce(Error("workspace"));
    await expect(readWorkspaceSessionInventory(session, workspaceId, f.options)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("closes on cancellation and bounds a stalled socket without accepting a partial list", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), duration);
      return controller.signal;
    });
    const f = fixture();
    f.socket.onGo = () => {};
    const pending = readWorkspaceSessionInventory(session, workspaceId, f.options);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8001);
    await rejected;
    expect(f.socket.closes).toEqual([1000]);

    const g = fixture(),
      cancel = new AbortController();
    g.socket.onGo = () => cancel.abort();
    await expect(
      readWorkspaceSessionInventory(session, workspaceId, { ...g.options, signal: cancel.signal }),
    ).rejects.toThrow();
    expect(g.socket.closes).toEqual([1000]);
  });

  it("closes a late upgrade after cancellation without sending control or retrying", async () => {
    const f = fixture(),
      cancel = new AbortController();
    let release!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = readWorkspaceSessionInventory(session, workspaceId, {
      ...f.options,
      signal: cancel.signal,
    });
    while (!release) await Promise.resolve();
    cancel.abort();
    await expect(pending).rejects.toThrow();
    release({ status: 101, webSocket: f.socket } as unknown as Response);
    await Promise.resolve();
    expect(f.socket.closes).toEqual([1008]);
    expect(f.socket.sent).toEqual([]);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("executes the exact Python framing/bounds wrapper with a pipe-backed subprocess double", async () => {
    const f = fixture();
    await readWorkspaceSessionInventory(session, workspaceId, f.options);
    const script = f.command().slice("python3 -I -c '".length, -1);
    const prefix = f.socket.prefix;
    const prelude = `import io,os,select,subprocess,sys,termios
class Input(io.StringIO):
    def fileno(self): return 0
sys.stdin = Input(${JSON.stringify(`${prefix}_GO\n${prefix}_ACK\n`)})
select.select = lambda *args: ([sys.stdin],[],[])
termios.tcgetattr = lambda *args: [0,0,0,termios.ECHO,0,0,[]]
termios.tcsetattr = lambda *args: None
class Child:
    def __init__(self, command, **kwargs):
        assert command == ["/usr/bin/tmux","-L","web","list-sessions","-F","#{session_name}:#{session_created}:#{session_windows}"]
        self.stdout = self.pipe(b"existing:1700000000:2\\n")
        self.stderr = self.pipe(b"")
    def pipe(self, data):
        read,write = os.pipe()
        os.write(write,data)
        os.close(write)
        return os.fdopen(read,"rb")
    def poll(self): return 0
    def wait(self, **kwargs): return 0
subprocess.Popen = Child
`;
    const actual = spawnSync("python3", ["-I", "-c", `${prelude}\n${script}`], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 131072,
    });
    expect(actual.status).toBe(0);
    expect(actual.stderr).toBe("");
    expect(actual.stdout).toContain(`${prefix}_READY\n`);
    expect(actual.stdout).not.toContain("_FAILED");
    const encoded = actual.stdout.split(`${prefix}_RESULT\n`)[1].split(`\n${prefix}_END`)[0];
    expect(JSON.parse(Buffer.from(encoded, "base64").toString())).toEqual({
      exitCode: 0,
      stdout: "existing:1700000000:2\n",
      stderr: "",
    });
  });
});
