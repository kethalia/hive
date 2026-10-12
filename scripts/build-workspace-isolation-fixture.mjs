import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");

export async function buildIsolationFixture(outputDir) {
  await mkdir(outputDir, { recursive: true });
  await build({
    entryPoints: ["e2e/fixtures/workspace-app-isolation.tsx"],
    outfile: resolve(outputDir, "bundle.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "fixture-server-boundary",
        setup(build) {
          build.onResolve({ filter: /TerminalTabManager$/ }, () => ({
            path: "terminal",
            namespace: "fixture-next",
          }));
          build.onResolve({ filter: /^@\/lib\/actions\/workspaces$/ }, () => ({
            path: resolve("e2e/fixtures/workspace-app-isolation-actions.ts"),
          }));
          build.onResolve({ filter: /^next\/(dynamic|link)$/ }, ({ path }) => ({
            path,
            namespace: "fixture-next",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture-next" }, ({ path }) => ({
            contents:
              path === "terminal"
                ? "export function TerminalTabManager() { return <p>Fixture terminal</p>; }"
                : path.endsWith("dynamic")
                  ? "export default function dynamic() { return function Terminal() { return <p>Fixture terminal</p>; }; }"
                  : "export default function Link({children, href}) { return <a href={href}>{children}</a>; }",
            loader: "tsx",
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  await build({
    entryPoints: ["src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts"],
    outfile: resolve(outputDir, "retired-proxy.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  await build({
    stdin: {
      contents:
        'export * from "./src/lib/security/workspace-app-isolation"; export * from "./src/lib/security/content-security-policy";',
      resolveDir: process.cwd(),
    },
    outfile: resolve(outputDir, "isolation-policy.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const styles = await postcss([tailwindcss()]).process(
    await readFile("src/app/globals.css", "utf8"),
    { from: "src/app/globals.css" },
  );
  await writeFile(resolve(outputDir, "style.css"), styles.css);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildIsolationFixture(process.argv[2]);
