// Separate terminal write capability; attaches an existing verified tmux client.
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { createTicketVerifier } from "./codex-session-bridge.mjs";

const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const check = (v) => {
  if (!v) throw new Error("terminal_rejected");
};
function launchPty(projectId) {
  const child = spawn(
    "/usr/bin/python3",
    [new URL("./codex-project-terminal.py", import.meta.url).pathname, projectId],
    { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" }, detached: true },
  );
  return child;
}
export function createProjectTerminal(config, { authorize, onRevoked, launch = launchPty }) {
  const sessions = new Set(),
    inputClosures = new Map();
  const validClosure = (projectId, barrier) => {
    check(typeof projectId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(projectId));
    check(
      exact(barrier, ["id", "generation"]) &&
        typeof barrier.id === "string" &&
        /^[A-Za-z0-9-]{1,100}$/.test(barrier.id) &&
        Number.isSafeInteger(barrier.generation) &&
        barrier.generation > 0,
    );
  };
  const assertInputs = (projectId) => check(!inputClosures.has(projectId));
  const inventory = (projectId) => {
    const active = [...sessions].filter((s) => s.projectId === projectId);
    return {
      projectId,
      closed: inputClosures.has(projectId),
      activeTerminals: active.filter((s) => !s.cleaned).length,
      helpersPendingClose: active.filter((s) => s.child && !s.reaped).length,
      pendingInputs: active.reduce(
        (n, s) => n + (s.child && !s.cleaned ? s.child.stdin.writableLength : 0),
        0,
      ),
      unknownInputs: active.some((s) => s.uncertain) ? 1 : 0,
    };
  };
  const verifier = createTicketVerifier(config, authorize, "session:terminal");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const unsubscribe = onRevoked(() => {
    for (const c of wss.clients) c.close(1008, "Authority revoked");
  });
  let closed = false;
  wss.on("connection", (client) => {
    const session = {
      projectId: null,
      child: null,
      cleaned: false,
      reaped: false,
      uncertain: false,
    };
    sessions.add(session);
    let binding,
      pty,
      expiry,
      expiresAt = 0,
      ready = false,
      output = Buffer.alloc(0),
      rate = 64,
      last = Date.now();
    const close = () => {
      client.close(1008, "Terminal capability or protocol rejected");
      cleanup();
    };
    const send = (v) => {
      const raw = JSON.stringify(v);
      if (Buffer.byteLength(raw) > 262144 || client.bufferedAmount > 262144) return close();
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    };
    const deadline = setTimeout(close, 5000);
    const timer = setInterval(() => {
      try {
        if (binding) authorize(binding);
      } catch {
        close();
      }
    }, 1000);
    const setExpiry = (exp) => {
      clearTimeout(expiry);
      expiresAt = exp;
      expiry = setTimeout(close, Math.max(1, exp * 1000 - Date.now()));
    };
    let cleaned = false;
    session.stop = close;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      session.cleaned = true;
      if (!pty) sessions.delete(session);
      clearTimeout(deadline);
      clearTimeout(expiry);
      clearInterval(timer);
      if (pty) {
        pty.stdin.destroy();
        pty.kill("SIGTERM");
        const child = pty;
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode == null && !session.reaped)
            child.kill("SIGKILL");
        }, 1000).unref();
      }
    };
    client.on("close", cleanup);
    client.on("error", cleanup);
    client.on("message", (raw, binary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        check(!binary && raw.length <= 65536);
        const now = Date.now();
        rate = Math.min(64, rate + ((now - last) / 1000) * 32);
        last = now;
        check(rate >= 1);
        rate--;
        const value = JSON.parse(raw);
        if (!binding) {
          check(exact(value, ["type", "ticket"]) && value.type === "authenticate");
          const c = verifier.accept(value.ticket);
          binding = {
            ownerId: c.sub,
            workspaceId: c.workspaceId,
            buildId: c.buildId,
            serverInstanceId: c.serverInstanceId,
            threadId: c.threadId,
          };
          const { projectId } = authorize(binding);
          session.projectId = projectId;
          assertInputs(projectId);
          setExpiry(c.exp);
          pty = launch(projectId);
          session.child = pty;
          pty.on("error", close);
          pty.stdin.on("error", close);
          pty.on("close", (code) => {
            session.reaped = true;
            sessions.delete(session);
            if (cleaned) return;
            send({ type: "exit", code });
            client.close(1000, "Terminal closed");
          });
          pty.stdout.on("data", (chunk) => {
            try {
              output = Buffer.concat([output, chunk]);
              check(output.length <= 262144);
              while (output.includes(10)) {
                const at = output.indexOf(10);
                const line = output.subarray(0, at);
                output = output.subarray(at + 1);
                const message = JSON.parse(line);
                if (message.type === "ready") {
                  check(!ready && exact(message, ["type"]));
                  ready = true;
                  clearTimeout(deadline);
                  send(message);
                } else if (message.type === "output") {
                  check(
                    ready &&
                      exact(message, ["type", "text"]) &&
                      typeof message.text === "string" &&
                      Buffer.byteLength(message.text) <= 65536,
                  );
                  send(message);
                } else {
                  check(
                    exact(message, ["type", "code"]) &&
                      message.type === "exit" &&
                      (message.code === null || Number.isInteger(message.code)),
                  );
                  send(message);
                  client.close(1000, "Terminal exited");
                }
              }
            } catch {
              close();
            }
          });
          return;
        }
        authorize(binding);
        assertInputs(session.projectId);
        check(expiresAt * 1000 > Date.now());
        if (value.type === "renew") {
          check(exact(value, ["type", "ticket"]));
          const c = verifier.accept(value.ticket);
          check(
            c.sub === binding.ownerId &&
              ["workspaceId", "buildId", "serverInstanceId", "threadId"].every(
                (k) => c[k] === binding[k],
              ),
          );
          setExpiry(c.exp);
          send({ type: "renewed", expiresAt: c.exp });
          return;
        }
        check(ready && pty && pty.stdin.writableLength <= 262144);
        if (value.type === "input")
          check(
            exact(value, ["type", "text"]) &&
              typeof value.text === "string" &&
              Buffer.byteLength(value.text) <= 32768,
          );
        else
          check(
            value.type === "resize" &&
              exact(value, ["type", "cols", "rows"]) &&
              [value.cols, value.rows].every((v) => Number.isInteger(v) && v >= 2 && v <= 500),
          );
        pty.stdin.write(`${JSON.stringify(value)}\n`);
      } catch {
        close();
      }
    });
  });
  return {
    inputInventory(projectId) {
      return inventory(projectId);
    },
    async closeProjectInputs(projectId, barrier) {
      validClosure(projectId, barrier);
      const existing = inputClosures.get(projectId);
      check(!existing || JSON.stringify(existing) === JSON.stringify(barrier));
      // Install before touching sockets: queued input/renewal and new authentication
      // cannot admit another helper after this synchronous point.
      inputClosures.set(projectId, structuredClone(barrier));
      for (const s of sessions) if (s.projectId === projectId) s.stop();
      const deadline = performance.now() + 3000;
      while (inventory(projectId).helpersPendingClose) {
        check(performance.now() < deadline);
        await new Promise((r) => setTimeout(r, 10));
      }
      const result = inventory(projectId);
      check(!result.activeTerminals && !result.pendingInputs && !result.unknownInputs);
      return result; // Foreground input only; never a descendant/kernel writer proof.
    },
    async releaseProjectInputs(projectId, barrier, authorizeRelease) {
      validClosure(projectId, barrier);
      check(JSON.stringify(inputClosures.get(projectId)) === JSON.stringify(barrier));
      check(typeof authorizeRelease === "function");
      await authorizeRelease(projectId, structuredClone(barrier));
      check(JSON.stringify(inputClosures.get(projectId)) === JSON.stringify(barrier));
      const result = inventory(projectId);
      check(
        !result.activeTerminals &&
          !result.helpersPendingClose &&
          !result.pendingInputs &&
          !result.unknownInputs,
      );
      inputClosures.delete(projectId);
    },
    handleUpgrade(req, socket, head) {
      if (
        closed ||
        req.url !== "/terminal" ||
        req.headers.origin !== config.hiveOrigin ||
        req.headers.host !== new URL(config.appOrigin).host ||
        wss.clients.size >= 8
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client));
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      verifier.close();
    },
  };
}
