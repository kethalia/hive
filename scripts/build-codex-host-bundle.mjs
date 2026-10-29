#!/usr/bin/env node
// Build from the checked-out lockfile installation, without remote npm installs.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url),
  { build } = require("esbuild");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (process.argv.length !== 3) throw new Error("Expected a new absolute output directory");
const out = process.argv[2];
if (resolve(out) !== out) throw new Error("Absolute output required");
const ws = JSON.parse(readFileSync(require.resolve("ws/package.json")));
if (ws.version !== "8.21.3") throw new Error("Unsupported locked ws distribution");
mkdirSync(out, { mode: 0o700 });
mkdirSync(join(out, "vendor"), { mode: 0o700 });
await build({
  absWorkingDir: root,
  preserveSymlinks: true,
  stdin: { contents: 'export {default,WebSocket,WebSocketServer} from "ws";', resolveDir: root },
  outfile: join(out, "vendor/ws.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: 'import { createRequire as vendorCreateRequire } from "node:module"; const require = vendorCreateRequire(import.meta.url);',
  },
});
const source = join(root, "templates/ai-dev-k8s/scripts");
const modules = [
  "codex-workspace-host.mjs",
  "codex-process-identity.mjs",
  "codex-project-controller.mjs",
  "codex-project-discovery.mjs",
  "codex-project-supervisor.mjs",
  "codex-native-namespace.mjs",
  "codex-project-gateway.mjs",
  "codex-session-bridge.mjs",
  "codex-host-registration.mjs",
  "codex-project-terminal.mjs",
  "delivery-manager-adapter.mjs",
  "delivery-native-spool.mjs",
];
const assets = [
  "managed-projects.py",
  "github-projects.py",
  "codex-project-terminal.py",
  "codex-project-lease.py",
  "install-codex-runtime.py",
];
for (const name of modules)
  writeFileSync(
    join(out, name),
    readFileSync(join(source, name), "utf8").replaceAll('from "ws"', 'from "./vendor/ws.mjs"'),
    { mode: 0o500, flag: "wx" },
  );
for (const name of assets) copyFileSync(join(source, name), join(out, name), 1);
const files = Object.fromEntries(
  [...modules, ...assets, "vendor/ws.mjs"].map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(out, name)))
      .digest("hex"),
  ]),
);
writeFileSync(
  join(out, "package-manifest.json"),
  `${JSON.stringify(
    { schemaVersion: 1, nodeMajor: 24, wsVersion: ws.version, nativeVersion: "0.165.0", files },
    null,
    2,
  )}\n`,
  { mode: 0o400, flag: "wx" },
);
console.log(
  JSON.stringify({
    directory: out,
    files: Object.keys(files).length,
    wsVersion: ws.version,
    nativeVersion: "0.165.0",
  }),
);
