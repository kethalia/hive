import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const destination = process.argv[2];
if (!destination) throw new Error("Supply a preview output directory");
await mkdir(destination, { recursive: true });
const snapshot = {
  profile: "software",
  checkedAt: 1792600000,
  coderMcpSupported: true,
  typescriptServerInstalled: true,
  agents: ["codex", "claude"].map((agent) => ({
    agent,
    installed: true,
    version: agent === "codex" ? "0.163.0" : "2.1.170",
    auth: "signed-in",
    tracking: false,
    connections: [{ name: "github", enabled: true, auth: "unknown" }],
    plugins:
      agent === "claude" ? [{ name: "typescript-lsp@claude-plugins-official", enabled: true }] : [],
    warnings: [],
  })),
  sessions: [
    {
      key: "codex-11111111-1111-4111-8111-111111111111",
      agent: "codex",
      id: "11111111-1111-4111-8111-111111111111",
      project: "hive",
      directory: "projects/kethalia/hive",
      updatedAt: 1792599000,
      state: "offline",
      running: false,
      directoryExists: true,
    },
    {
      key: "claude-22222222-2222-4222-8222-222222222222",
      agent: "claude",
      id: "22222222-2222-4222-8222-222222222222",
      project: "website",
      directory: "projects/example/website",
      updatedAt: 1792598000,
      state: "needs-input",
      running: true,
      directoryExists: true,
    },
  ],
};
await build({
  entryPoints: ["e2e/fixtures/agent-tools.tsx"],
  bundle: true,
  outfile: `${destination}/bundle.js`,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "agent-action-fixtures",
      setup(build) {
        build.onLoad({ filter: /src\/lib\/actions\/agent-tools\.ts$/ }, () => ({
          loader: "ts",
          contents: `
      const snapshot = ${JSON.stringify(snapshot)};
      export const inspectAgentToolsAction = async () => {
        if (new URL(location.href).searchParams.has('failure')) return { serverError: 'Start this workspace first.' };
        return { data: structuredClone(snapshot) };
      };
      export const configureAgentToolsAction = async ({ operation }) => {
        window.lastAgentOperation = operation;
        if (operation === 'install' || operation === 'disable') snapshot.agents.forEach(agent => agent.tracking = operation === 'install');
        return { data: { message: 'Restart agents; review Codex /hooks.' } };
      };
      export const resumeAgentSessionAction = async ({ key }) => ({ data: { sessionName: 'hive-' + key } });
    `,
        }));
      },
    },
  ],
});
const styles = await postcss([tailwindcss()]).process(
  await readFile("src/app/globals.css", "utf8"),
  { from: "src/app/globals.css" },
);
await writeFile(`${destination}/style.css`, styles.css);
await writeFile(
  `${destination}/index.html`,
  '<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
);
await copyFile("e2e/agent-tools.browser.mjs", `${destination}/validate.mjs`);
