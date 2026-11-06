import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const paths = [
  "deploy/cloudflare/app/project-relay.ts",
  "deploy/cloudflare/app/local-relay-fixture.ts",
  "deploy/cloudflare/app/local-relay-provider.ts",
  "deploy/cloudflare/app/run-local-relay-proof.mjs",
];
const sustained = process.argv.includes("--sustained");
const digest = async () =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
const sources = await digest(),
  revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const directory = await mkdtemp(join(tmpdir(), "hive-relay-proof-")),
  bearer = randomBytes(32).toString("hex");
await writeFile(
  join(directory, "wrangler.json"),
  JSON.stringify({
    name: "hive-local-relay-proof",
    main: resolve("deploy/cloudflare/app/local-relay-fixture.ts"),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    services: [{ binding: "PROVIDER", service: "hive-local-relay-provider" }],
  }),
  { mode: 0o600 },
);
await writeFile(join(directory, ".dev.vars"), `RELAY_PROOF_BEARER=${bearer}\n`, { mode: 0o600 });
await writeFile(
  join(directory, "provider.json"),
  JSON.stringify({
    name: "hive-local-relay-provider",
    main: resolve("deploy/cloudflare/app/local-relay-provider.ts"),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
  }),
  { mode: 0o600 },
);
function once(socket, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      socket.off("error", onError);
      if (eventName !== "close") socket.off("close", onClose);
    };
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = () => {
      cleanup();
      reject(new Error("Local socket error"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Local socket closed before expected event"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Local socket event deadline"));
    }, 10000);
    socket.once(eventName, onEvent);
    socket.once("error", onError);
    if (eventName !== "close") socket.once("close", onClose);
  });
}
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    join(directory, "wrangler.json"),
    "--config",
    join(directory, "provider.json"),
    "--ip",
    "127.0.0.1",
    "--port",
    "8794",
    "--inspector-port",
    "0",
  ],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
let log = "";
child.stdout.on("data", (data) => {
  log += data;
});
child.stderr.on("data", (data) => {
  log += data;
});
const sockets = [];
let stage = "startup";
const headers = {
  Authorization: `Bearer ${bearer}`,
  Origin: "http://127.0.0.1:8794",
  Cookie: "__Host-hive-session=fixture",
};
async function connect(short = false) {
  stage = short ? "short-lived-connect" : "connect";
  const socket = new WebSocket(
    "ws://127.0.0.1:8794/api/projects/00000000-0000-4000-8000-000000000001/session",
    {
      headers: { ...headers, ...(short ? { "X-Local-Short-Lifetime": "yes" } : {}) },
      handshakeTimeout: 10000,
    },
  );
  sockets.push(socket);
  socket.on("error", () => {});
  await once(socket, "open");
  stage = "authenticate";
  const reply = once(socket, "message");
  socket.send('{"type":"auth","ticket":"fixture-signed-ticket"}');
  const [message] = await reply;
  if (message.toString() !== "fixture-authenticated") throw new Error("Fixture auth failed");
  return socket;
}
try {
  const deadline = Date.now() + 60000;
  while (!log.includes("Ready on")) {
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error("Local relay runtime failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const socket = await connect();
  stage = "text";
  const text = once(socket, "message");
  socket.send("fixture-text");
  if ((await text)[0].toString() !== "fixture-text") throw new Error("Text transport failed");
  const binary = once(socket, "message");
  stage = "binary";
  socket.send(Buffer.from([1, 2, 3]));
  const [bytes, isBinary] = await binary;
  if (!isBinary || !bytes.equals(Buffer.from([1, 2, 3])))
    throw new Error("Binary transport failed");
  let sustainedMilliseconds = 0,
    reauthorizations = 0;
  if (sustained) {
    stage = "sustained-same-connection";
    const started = Date.now();
    for (let index = 0; index < 6; index++) {
      await new Promise((resolve) => setTimeout(resolve, 11000));
      const reply = once(socket, "message"),
        value = `sustained-${index}`;
      socket.send(value);
      if ((await reply)[0].toString() !== value) throw new Error("Sustained transport failed");
    }
    sustainedMilliseconds = Date.now() - started;
    const status = await fetch("http://127.0.0.1:8794/__local-relay-status", {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10000),
    });
    reauthorizations = (await status.json()).reauthorizations;
    if (sustainedMilliseconds < 65000 || reauthorizations < 3)
      throw new Error("Sustained authority refresh missing");
  }
  const closed = once(socket, "close");
  stage = "sanitized-close";
  socket.send("fixture-close");
  const [code, reason] = await closed;
  if (code !== 1008 || reason.toString() !== "Project peer closed")
    throw new Error("Close reason was not sanitized");
  const oversized = await connect(),
    largeClosed = once(oversized, "close");
  stage = "oversized-frame";
  oversized.send(Buffer.alloc(1024 * 1024 + 1));
  if ((await largeClosed)[0] !== 1009) throw new Error("Frame limit failed");
  const expiry = await connect(true),
    expired = once(expiry, "close");
  stage = "expiry";
  const [expiredCode] = await expired;
  if (expiredCode !== 1008) throw new Error("Deadline failed");
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    testedRevision: revision,
    testedSourceCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...paths], {
      encoding: "utf8",
    }).trim(),
    sourceStable: JSON.stringify(sources) === JSON.stringify(await digest()),
    sourceDigests: sources,
    scope: "actual local workerd WebSocket relay, simulated provider and auth metadata",
    checks: {
      textRelay: true,
      binaryRelay: true,
      sanitizedClose: true,
      oversizedFrameRejected: true,
      shorterPreviewDeadlineClosed: true,
      ...(sustained ? { sameConnectionBeyond60Seconds: true, periodicFreshAuthority: true } : {}),
    },
    ...(sustained ? { sustainedMilliseconds, reauthorizations } : {}),
    providerSimulated: true,
    authMetadataSimulated: true,
    databaseUsed: false,
    realCoderUsed: false,
    cloudWrites: 0,
  };
  const path = "docs/checks/autonomous-delivery/cloudflare-relay-local.json";
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", path], { stdio: "ignore" });
  console.log(
    JSON.stringify({
      ok: evidence.sourceStable,
      checks: evidence.checks,
      providerSimulated: true,
      cloudWrites: 0,
    }),
  );
  if (!evidence.sourceStable) process.exitCode = 1;
} catch {
  console.error(
    `Local relay workerd proof failed at ${stage}; inspect the private runtime log. No secrets printed.`,
  );
  process.exitCode = 1;
} finally {
  for (const socket of sockets)
    try {
      socket.terminate();
    } catch {}
  await writeFile("/tmp/hive-local-relay-private.log", log, { mode: 0o600 });
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
