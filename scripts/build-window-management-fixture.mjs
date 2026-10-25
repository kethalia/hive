import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const output = resolve(process.argv[2] ?? ".artifacts/window-management/browser");
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["e2e/fixtures/window-management.tsx"],
  outfile: resolve(output, "bundle.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "fixture-boundaries",
      setup(build) {
        const mocks = {
          "next/navigation":
            'const search = new URLSearchParams(); const router = {replace() {},push() {}}; export const useRouter = () => router; export const useSearchParams = () => search; export const usePathname = () => "/workspaces";',
          "next/dynamic":
            'import {lazy,Suspense} from "react"; export default function dynamic(load) { const C = lazy(async () => ({default: await load()})); return function Dynamic(props) { return <Suspense fallback={<p>Loading…</p>}><C {...props}/></Suspense> }; }',
          "@/hooks/useGeneralWorkspaceCommands": "export function useGeneralWorkspaceCommands() {}",
          "@/lib/discovery/queries":
            'const workspaces=[{id:"software",name:"ai-dev-01",template_name:"ai-dev-k8s",latest_build:{id:"build-1",status:"running"}}]; const refresh=async()=>{}; export function useDiscovery(kind) {return {data:kind === "workspaces" ? workspaces : {agentId:"agent",agentStatus:"connected"},refresh,isPending:false};}',
          "@/lib/actions/workspaces":
            'export async function startWorkspaceAction(){return {data:{}};} export async function getWorkspaceSessionToolsAction(){return {data:{}};} export async function getWorkspaceAppToolAction(input){window.fixture.appRequests++;return {data:{url:"http://127.0.0.1:8832/"+input.tool}};}',
          "@/lib/actions/git-clones":
            'export async function resolveGitCloneTerminalAction(){return {data:{}};} export async function resolveGitCloneNotificationAction(){return {serverError:"Fixture repository unavailable"};}',
          "@/app/(dashboard)/workspaces/workspace-list-content":
            "export function WorkspaceListContent(){return <p>Coder workspaces</p>;}",
          "./AgentToolsDialog": "export function AgentToolsDialog(){return <p>Agent tools</p>;}",
          "./InteractiveTerminal":
            'export { FixtureTerminal as InteractiveTerminal } from "@/fixtures/window-management";',
        };
        build.onResolve({ filter: /.*/ }, ({ path }) =>
          path in mocks
            ? { path, namespace: "mock" }
            : path === "@/fixtures/window-management"
              ? { path: resolve("e2e/fixtures/window-management.tsx") }
              : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
          contents: mocks[path],
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const css = await postcss([tailwindcss()]).process(await readFile("src/app/globals.css", "utf8"), {
  from: "src/app/globals.css",
});
await writeFile(resolve(output, "style.css"), css.css);
await writeFile(
  resolve(output, "index.html"),
  '<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
);
