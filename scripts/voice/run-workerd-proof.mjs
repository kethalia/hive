import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createVoiceHost } from "./voice-host.mjs";

const keys = generateKeyPairSync("ed25519");
const config = {
  issuerPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
  issuerKeyId: "test",
  issuer: "https://hive.example",
  audience: "https://voice.example",
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  agentId: randomUUID(),
  lockDirectory: "/tmp",
  manifestSha256: "a".repeat(64),
};
const binding = {
  coderOrigin: "https://coder.example",
  hiveUserId: randomUUID(),
  ownerId: randomUUID(),
  workspaceId: config.workspaceId,
  buildId: config.buildId,
  agentId: config.agentId,
  templateId: randomUUID(),
  appOrigin: config.audience,
  appId: randomUUID(),
};
const clientConfig = {
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  keyId: config.issuerKeyId,
  issuer: config.issuer,
  manifestSha256: config.manifestSha256,
  lockDirectory: config.lockDirectory,
};
const fixture = `const { WebSocketServer } = require('ws'); const { Duplex } = require('node:stream'); const http = require('node:http'); const server = http.createServer(); const ws = new WebSocketServer({noServer:true}); server.on('upgrade',(req,socket,head)=>ws.handleUpgrade(req,socket,head,client=>client.on('message',raw=>{const r=JSON.parse(raw.toString()); if(r.id) client.send(JSON.stringify({id:r.id,result:r.method==='thread/loaded/list'?{data:['fixture']}:{} }));}))); server.emit('connection',Duplex.from({readable:process.stdin,writable:process.stdout}));`;
const host = createVoiceHost(config, {
  spawn: () => spawn(process.execPath, ["-e", fixture], { stdio: ["pipe", "pipe", "pipe"] }),
});
host.server.listen(0, "127.0.0.1");
await once(host.server, "listening");
const dir = await mkdtemp(join(tmpdir(), "voice-proof-"));
const wranglerConfig = join(dir, "wrangler.json");
await writeFile(
  wranglerConfig,
  JSON.stringify({
    name: "voice-proof",
    main: resolve("scripts/voice/voice-workerd-fixture.ts"),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      HOST_URL: `http://127.0.0.1:${host.server.address().port}`,
      CONFIG_JSON: JSON.stringify(clientConfig),
      BINDING_JSON: JSON.stringify(binding),
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
    "18943",
    "--inspector-port",
    "0",
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (output.includes("Ready on")) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error(`workerd failed to start: ${output.slice(-2000)}`);
  const response = await fetch("http://127.0.0.1:18943/proof");
  const result = await response.text();
  if (response.status !== 200 || JSON.parse(result).result.data[0] !== "fixture")
    throw new Error(`proof failed ${response.status}: ${result.slice(0, 500)}`);
  process.stdout.write("workerd voice RPC to local host fixture passed\n");
} finally {
  child.kill();
  host.close();
  await rm(dir, { recursive: true, force: true });
}
