#!/usr/bin/env node
// Build from the checked-out lockfile installation, without remote npm installs.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGuardianArtifact } from "./build-native-guardian.mjs";

const require = createRequire(import.meta.url),
  { build, transform } = require("esbuild");
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
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: false,
  keepNames: true,
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
  "codex-workspace-host-outer.mjs",
  "codex-workspace-host-worker.mjs",
  "codex-guardian-startup.mjs",
  "codex-process-identity.mjs",
  "codex-project-controller.mjs",
  "codex-project-discovery.mjs",
  "codex-project-supervisor.mjs",
  "codex-native-namespace.mjs",
  "codex-native-guardian.mjs",
  "codex-host-guardian.mjs",
  "codex-guardian-worker.mjs",
  "codex-guardian-controller.mjs",
  "codex-project-gateway.mjs",
  "codex-session-bridge.mjs",
  "codex-host-registration.mjs",
  "codex-project-terminal.mjs",
  "delivery-manager-adapter.mjs",
  "delivery-native-spool.mjs",
  "delivery-github-collector.mjs",
  "delivery-github-journal.mjs",
  "delivery-source-publisher.mjs",
  "delivery-source-publisher-journal.mjs",
  "delivery-source-state-client.mjs",
];
const assets = [
  "managed-projects.py",
  "managed-source-apply.py",
  "github-projects.py",
  "github-evidence.py",
  "delivery-source-broker.py",
  "delivery-source-provider.py",
  "delivery-source-runtime.py",
  "delivery-source-worker.py",
  "codex-project-terminal.py",
  "codex-project-lease.py",
  "install-codex-runtime.py",
];
// A separately built, reviewed artifact is opt-in. This never invokes a compiler.
const guardianArtifact = process.env.HIVE_GUARDIAN_ARTIFACT_DIR
  ? validateGuardianArtifact(root, resolve(process.env.HIVE_GUARDIAN_ARTIFACT_DIR))
  : null;
// Identifier/whitespace compaction preserves runtime names and avoids syntax minification while
// fitting the existing pod metadata budget. The artifact builder recomputes this
// exact transform before omitting any loose source from the distributable tar.
for (const name of modules)
  writeFileSync(
    join(out, name),
    (
      await transform(
        readFileSync(join(source, name), "utf8").replaceAll('from "ws"', 'from "./vendor/ws.mjs"'),
        {
          loader: "js",
          format: "esm",
          target: "node24",
          minifyWhitespace: true,
          minifyIdentifiers: true,
          minifySyntax: false,
          keepNames: true,
        },
      )
    ).code,
    { mode: 0o500, flag: "wx" },
  );
for (const name of assets) copyFileSync(join(source, name), join(out, name), 1);
if (guardianArtifact) {
  writeFileSync(join(out, "codex-native-guardian"), guardianArtifact.binary, {
    mode: 0o500,
    flag: "wx",
  });
}
const files = Object.fromEntries(
  [
    ...modules,
    ...assets,
    "vendor/ws.mjs",
    ...(guardianArtifact ? ["codex-native-guardian"] : []),
  ].map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(out, name)))
      .digest("hex"),
  ]),
);
writeFileSync(
  join(out, "package-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      nodeMajor: 24,
      wsVersion: ws.version,
      nativeVersion: "0.165.0",
      files,
      ...(guardianArtifact ? { guardian: guardianArtifact.manifest } : {}),
    },
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
