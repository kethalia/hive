import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentBridge } from "./host.mjs";

const root = await mkdtemp(join(tmpdir(), "hive-agent-proof-"));
const source = await readFile("templates/ai-dev-k8s/scripts/agent-tools.py"),
  helper = join(root, "agent-tools.py");
await writeFile(helper, source, { mode: 0o600 });
await mkdir(join(root, "custom-codex"), { mode: 0o700 });
await mkdir(join(root, "custom-claude"), { mode: 0o700 });
await writeFile(
  join(root, "custom-codex/hooks.json"),
  JSON.stringify({
    userSetting: "preserved",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "unrelated" }] }] },
  }),
);
const keys = generateKeyPairSync("ed25519"),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const binding = {
  coderOrigin: "https://coder.example",
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  agentId: randomUUID(),
  templateId: randomUUID(),
  appOrigin: "https://hive-agent--main--work--owner.apps.example.com",
  appId: randomUUID(),
};
const hostConfig = {
  issuer: "https://hive.example",
  issuerKeyId: "test",
  issuerPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
  binding,
  profile: "software",
  home: root,
  manifestSha256: "a".repeat(64),
  helperSha256: sha(source),
};
const bridge = createAgentBridge(hostConfig, {
  helperPath: helper,
  environment: {
    CODEX_HOME: join(root, "custom-codex"),
    CLAUDE_CONFIG_DIR: join(root, "custom-claude"),
  },
});
bridge.server.listen(0, "127.0.0.1");
await once(bridge.server, "listening");
const config = {
  issuer: hostConfig.issuer,
  keyId: "test",
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  binding,
  hiveUserId: randomUUID(),
  profile: hostConfig.profile,
  home: root,
  manifestSha256: hostConfig.manifestSha256,
  helperSha256: hostConfig.helperSha256,
};
const wranglerConfig = join(root, "wrangler.json");
await writeFile(
  wranglerConfig,
  JSON.stringify({
    name: "agent-proof",
    main: resolve("scripts/agent-bridge/fixture.worker.ts"),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      TARGET: `http://127.0.0.1:${bridge.server.address().port}/agent/operation`,
      CONFIG: JSON.stringify(config),
    },
  }),
);
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    wranglerConfig,
    "--ip",
    "127.0.0.1",
    "--port",
    "18944",
    "--inspector-port",
    "0",
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
let log = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (data) => {
    log = (log + data).slice(-2000);
  });
try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (log.includes("Ready on")) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error(`workerd startup failed: ${log}`);
  const response = await fetch("http://127.0.0.1:18944/proof"),
    body = await response.text();
  if (
    response.status !== 200 ||
    !Array.isArray(JSON.parse(body).sessions) ||
    JSON.parse(body).sessions.length !== 0 ||
    JSON.parse(body).workspaceReads < 12
  )
    throw new Error(`proof failed ${response.status}: ${body.slice(0, 400)}`);
  const hooks = JSON.parse(await readFile(join(root, "custom-codex/hooks.json"), "utf8"));
  if (
    hooks.userSetting !== "preserved" ||
    hooks.hooks.SessionStart[0].hooks[0].command !== "unrelated" ||
    JSON.stringify(hooks).includes("hive/agents/agent-tools.py")
  )
    throw new Error("tracking preservation failed");
  const denied = await (await fetch("http://127.0.0.1:18944/wrong-owner")).json();
  if (!denied.rejected || denied.code !== "unavailable" || denied.appCalls !== 0)
    throw new Error("owner denial proof failed");
  const changed = await (await fetch("http://127.0.0.1:18944/changed-build")).json();
  if (!changed.rejected || changed.code !== "outcome_unknown" || changed.appCalls !== 4)
    throw new Error("changed build proof failed");
  process.stdout.write(
    "workerd agent owner/build, scoped cookies, signed sessions and tracking mutations to actual local helper passed\n",
  );
} finally {
  child.kill();
  bridge.close();
  await rm(root, { recursive: true, force: true });
}
