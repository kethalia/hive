import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WebSocket } from "ws";
import { createProjectTerminal } from "../templates/ai-dev-k8s/scripts/codex-project-terminal.mjs";
import { validateConfig } from "../templates/ai-dev-k8s/scripts/codex-session-bridge.mjs";

async function fixture(t, launch) {
  const root = mkdtempSync(join(tmpdir(), "hive-terminal-")),
    keys = generateKeyPairSync("ed25519");
  const binding = {
    ownerId: "owner",
    workspaceId: "workspace",
    buildId: "build",
    serverInstanceId: "server",
  };
  const config = validateConfig(
    {
      schemaVersion: 1,
      protocolVersion: "0.165.0",
      binding,
      hiveOrigin: "https://hive.example.com",
      appOrigin: "https://app.example.com",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      keyId: "issuer",
      stateDirectory: root,
      port: 0,
    },
    true,
  );
  let active = true,
    launched = 0;
  const children = [];
  const terminal = createProjectTerminal(config, {
    authorize: (b) => {
      assert.ok(active);
      assert.equal(b.threadId, "thread");
      return { projectId: "11111111-1111-4111-8111-111111111111" };
    },
    onRevoked: () => () => {},
    launch:
      launch ??
      (() => {
        launched++;
        const c = new EventEmitter();
        c.stdin = new PassThrough();
        c.stdout = new PassThrough();
        c.exitCode = null;
        c.kill = () => {
          c.exitCode = 0;
          c.emit("close", 0);
        };
        children.push(c);
        setImmediate(() => c.stdout.write('{"type":"ready"}\n'));
        return c;
      }),
  });
  const server = createServer();
  server.on("upgrade", terminal.handleUpgrade);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    await terminal.close();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });
  const ticket = (patch = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "issuer" }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        iss: config.hiveOrigin,
        aud: config.appOrigin,
        origin: config.hiveOrigin,
        scope: "session:terminal",
        sub: binding.ownerId,
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
        serverInstanceId: binding.serverInstanceId,
        threadId: "thread",
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        ...patch,
      }),
    ).toString("base64url");
    return `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), keys.privateKey).toString("base64url")}`;
  };
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/terminal`, {
      headers: { Host: "app.example.com", Origin: config.hiveOrigin },
    });
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  return {
    terminal,
    ticket,
    connect,
    children,
    get launched() {
      return launched;
    },
    revoke() {
      active = false;
    },
  };
}
async function authenticate(f, patch) {
  const s = await f.connect();
  const next = once(s, "message");
  s.send(JSON.stringify({ type: "authenticate", ticket: f.ticket(patch) }));
  assert.equal(JSON.parse((await next)[0]).type, "ready");
  return s;
}
test("separate terminal capability rejects read scope and arbitrary RPC before launching a PTY", async (t) => {
  const f = await fixture(t);
  const bad = await f.connect();
  const closed = once(bad, "close");
  bad.send(JSON.stringify({ type: "authenticate", ticket: f.ticket({ scope: "session:read" }) }));
  assert.equal((await closed)[0], 1008);
  assert.equal(f.launched, 0);
  const s = await authenticate(f);
  const child = f.children[0];
  s.send(JSON.stringify({ type: "input", text: "hello" }));
  const [input] = await once(child.stdin, "data");
  assert.equal(JSON.parse(input).text, "hello");
  const stop = once(s, "close");
  s.send(JSON.stringify({ method: "shellCommand", params: { command: "bad" } }));
  assert.equal((await stop)[0], 1008);
});
test("same terminal renews in place; replay, changed binding and revoked lease close the client", async (t) => {
  const f = await fixture(t);
  const s = await authenticate(f),
    ticket = f.ticket();
  const renewed = once(s, "message");
  s.send(JSON.stringify({ type: "renew", ticket }));
  assert.equal(JSON.parse((await renewed)[0]).type, "renewed");
  assert.equal(f.launched, 1);
  const closed = once(s, "close");
  s.send(JSON.stringify({ type: "renew", ticket }));
  assert.equal((await closed)[0], 1008);
  const other = await authenticate(f),
    changed = once(other, "close");
  other.send(JSON.stringify({ type: "renew", ticket: f.ticket({ threadId: "other" }) }));
  assert.equal((await changed)[0], 1008);
  const active = await authenticate(f);
  const revoked = once(active, "close");
  f.revoke();
  assert.equal((await revoked)[0], 1008);
});
test("expiry closes an otherwise idle terminal without renewal", async (t) => {
  const f = await fixture(t);
  const s = await authenticate(f, { exp: Math.floor(Date.now() / 1000) + 1 });
  assert.equal((await once(s, "close"))[0], 1008);
});
test("real stdlib PTY attaches existing tmux session and client disconnect preserves the session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-terminal-pty-")),
    socket = join(root, "tmux.sock");
  execFileSync("/usr/bin/tmux", [
    "-f",
    "/dev/null",
    "-S",
    socket,
    "new-session",
    "-d",
    "-s",
    "fixture",
    "/bin/cat",
  ]);
  t.after(() => {
    try {
      execFileSync("/usr/bin/tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const module = resolve("templates/ai-dev-k8s/scripts/codex-project-terminal.py");
  const script = `import importlib.util,os,sys\ns=importlib.util.spec_from_file_location('terminal',${JSON.stringify(module)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.resolve_project=lambda _:(['/usr/bin/tmux','-S',${JSON.stringify(socket)},'attach-session','-t','fixture'],{'PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8'})\nsys.argv=['fixture','fixed-project']\nm.main()\n`;
  const f = await fixture(t, () =>
    spawn("/usr/bin/python3", ["-c", script], { stdio: ["pipe", "pipe", "ignore"] }),
  );
  const s = await authenticate(f);
  let text = "";
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PTY output timeout")), 3000);
    s.on("message", (raw) => {
      const v = JSON.parse(raw);
      if (v.type === "output") {
        text += v.text;
        if (text.includes("fixture-terminal-echo")) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  s.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  s.send(JSON.stringify({ type: "input", text: "fixture-terminal-echo\n" }));
  await received;
  s.close();
  await once(s, "close");
  execFileSync("/usr/bin/tmux", ["-S", socket, "has-session", "-t", "fixture"]);
});

test("project input closure waits for actual helper close and fences reconnects until trusted release", async (t) => {
  const f = await fixture(t),
    projectId = "11111111-1111-4111-8111-111111111111";
  const barrier = { id: randomUUID(), generation: 1 };
  const s = await authenticate(f),
    child = f.children[0];
  child.kill = () => true; // Signal delivery is not a reap/closed-pipe receipt.
  let finished = false;
  const closing = f.terminal.closeProjectInputs(projectId, barrier).then((v) => {
    finished = true;
    return v;
  });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(finished, false);
  assert.equal(f.terminal.inputInventory(projectId).helpersPendingClose, 1);
  assert.equal(child.stdin.destroyed, true);
  const reconnect = await f.connect(),
    rejected = once(reconnect, "close");
  reconnect.send(JSON.stringify({ type: "authenticate", ticket: f.ticket() }));
  assert.equal((await rejected)[0], 1008);
  assert.equal(f.launched, 1);
  child.exitCode = 0;
  child.emit("close", 0);
  assert.deepEqual(await closing, {
    projectId,
    closed: true,
    activeTerminals: 0,
    helpersPendingClose: 0,
    pendingInputs: 0,
    unknownInputs: 0,
  });
  await assert.rejects(f.terminal.releaseProjectInputs(projectId, barrier), /terminal_rejected/);
  await assert.rejects(
    f.terminal.releaseProjectInputs(projectId, barrier, async () => {
      throw new Error("authority_revoked");
    }),
    /authority_revoked/,
  );
  assert.equal(f.terminal.inputInventory(projectId).closed, true);
  await f.terminal.releaseProjectInputs(projectId, barrier, async () => {});
  assert.equal(f.terminal.inputInventory(projectId).closed, false);
  await authenticate(f);
  assert.equal(f.launched, 2);
  s.terminate();
});
