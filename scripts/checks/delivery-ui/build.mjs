import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const require = createRequire(resolve(root, "package.json"));
const vitestRequire = createRequire(require.resolve("vitest/package.json"));
const { build } = await import(pathToFileURL(vitestRequire.resolve("vite")).href);
const outDir = process.argv[2];
if (!outDir?.startsWith("/tmp/hive-")) throw new Error("Use a task scratch path under /tmp/hive-");
await mkdir(outDir, { recursive: true });
await build({
  root: directory,
  configFile: false,
  resolve: { alias: { "@": resolve(root, "src") } },
  esbuild: { jsx: "automatic" },
  css: { postcss: resolve(root) },
  build: { outDir, emptyOutDir: false, sourcemap: false },
});
const sourceFiles = [
  "src/components/delivery/DeliveryPanel.tsx",
  "src/components/projects/ConversationView.tsx",
  "src/lib/delivery/read-contracts.ts",
  "src/app/globals.css",
  "scripts/checks/delivery-ui/main.tsx",
];
const digests = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex"),
    ]),
  ),
);
await writeFile(
  resolve(outDir, "source-evidence.json"),
  `${JSON.stringify(
    {
      kind: "synthetic-component-harness",
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      sourceDirty: Boolean(
        execFileSync("git", ["status", "--porcelain", "--", ...sourceFiles], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      ),
      files: digests,
      nativeSessionVerified: false,
      authenticationVerified: false,
    },
    null,
    2,
  )}\n`,
);
