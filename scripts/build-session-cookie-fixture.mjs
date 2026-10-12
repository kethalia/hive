import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");

export async function buildSessionCookieFixture(directory) {
  await mkdir(directory, { recursive: true });
  await build({
    stdin: {
      contents: `export * from "./src/lib/auth/session-cookie";
        export * from "./src/lib/auth/session";
        export { POST as issueTicket } from "./src/app/api/auth/terminal-ticket/route";
        export { authenticateUpgrade } from "./services/terminal-proxy/src/auth";
        export { signCookie } from "./packages/auth/src/cookie";
        export { createCloneTerminalProof } from "./packages/auth/src/clone-terminal-proof";
        export { runWithRequest } from "./e2e/fixtures/session-cookie-next-headers";`,
      resolveDir: process.cwd(),
    },
    outfile: resolve(directory, "server.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "next-request-context",
        setup(build) {
          build.onResolve({ filter: /^next\/headers$/ }, () => ({
            path: resolve("e2e/fixtures/session-cookie-next-headers.ts"),
          }));
        },
      },
    ],
  });
  await build({
    entryPoints: ["src/lib/terminal/auth-transport.ts"],
    outfile: resolve(directory, "browser.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "HiveTerminalAuth",
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildSessionCookieFixture(process.argv[2]);
