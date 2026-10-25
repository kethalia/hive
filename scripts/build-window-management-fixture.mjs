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
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_HIVE_APP_VERSION": '"fixture"',
    "process.env.NEXT_PUBLIC_HIVE_APP_BUILD": '"fixture"',
  },
  plugins: [
    {
      name: "fixture-boundaries",
      setup(build) {
        const mocks = {
          "next/link": "export default function Link(props) {return <a {...props}/>;}",
          "@/lib/auth/actions":
            'export async function getSessionAction() {return {data:{user:{email:"fixture@example.test",coderUrl:"https://coder.example.test"}}};}',
          "next/navigation":
            'const search = new URLSearchParams(); const router = {replace() {},push() {},refresh() {}}; export const useRouter = () => router; export const useSearchParams = () => search; export const usePathname = () => "/workspaces";',
          "next/dynamic":
            'import {lazy,Suspense} from "react"; export default function dynamic(load) { const C = lazy(async () => ({default: await load()})); return function Dynamic(props) { return <Suspense fallback={<p>Loading…</p>}><C {...props}/></Suspense> }; }',
          "@/lib/discovery/transport":
            'import {fixtureWorkspaces,fixtureAgents,fixtureTemplates} from "@/fixtures/window-management"; export async function readDiscovery(kind) {if(kind === "workspaces") return fixtureWorkspaces; if(kind === "templates") return fixtureTemplates; if(kind === "template-options") return fixtureTemplates.map(t=>({id:t.name,name:t.name,activeVersionId:"v1",updatedAt:"2026-10-25"})); if(kind === "agent-tools") return fixtureAgents; if(kind === "sessions") return [{name:"codex"},{name:"claude"}]; if(kind === "repositories") return {nodes:[{kind:"repository",id:"repo",label:"hive",cloneSessionKey:"git-clone:projects/kethalia/hive",relativePath:"projects/kethalia/hive"}]}; return {agentId:"agent",agentStatus:"connected"};}',
          "@/lib/actions/clone-project":
            'export async function cloneProjectAction(input){window.fixture.clones = (window.fixture.clones || 0)+1;return {data:{kind:"terminal",workspaceId:input.workspaceId,sessionName:"cloned-project",label:input.repository}};}',
          "@/lib/actions/workspaces":
            'export async function createWorkspaceAction(input){window.fixture.createdWorkspace=input;return {data:{}};} export async function stopWorkspaceAction(){return {data:{}};} export async function deleteWorkspaceAction(){return {data:{}};} export async function startWorkspaceAction(){return {data:{}};} export async function createSessionAction(input){return {data:{name:input.sessionName || "new-session"}};} export async function getWorkspaceSessionToolsAction(){return {data:{}};} export async function getWorkspaceAppToolAction(input){window.fixture.appRequests++;window.fixture.lastAppRequest=input;return {data:{url:"http://127.0.0.1:8832/"+input.tool}};}',
          "@/lib/actions/git-clones":
            'export async function resolveGitCloneTerminalAction(input){return {data:{sessionName:"git-clone-fixture",clonePath:"/home/coder/"+input.relativePath,cloneSessionKey:input.cloneSessionKey,cloneProof:"fixture-proof"}};} export async function resolveGitCloneNotificationAction(){return {serverError:"Fixture repository unavailable"};}',
          "@/lib/actions/agent-tools":
            'export async function configureAgentToolsAction(){return {data:{message:"Updated"}};} export async function resumeAgentSessionAction(){return {data:{sessionName:"codex"}};}',
          "@/lib/actions/settings-window":
            "export async function getSettingsWindowAction(){return {data:{connectedWorkspaceIds:[],pendingWorkspaceIds:[],workspaces:[],workspaceError:false}};}",
          "@/lib/push/actions":
            "export async function testPushAction(){return {data:{success:true}};} export async function getVapidPublicKeyAction(){return {data:{}};}",
          "@/lib/push/subscribe":
            "export async function getPushPreferencesAction(){return {data:{preferences:{}}};} export async function updatePushPreferencesAction(){return {data:{success:true}};} export async function unsubscribePushAction(){return {data:{success:true}};} export async function subscribePushAction(){return {data:{success:true}};}",
          "@/components/runtime-config-provider":
            'export function useRuntimeConfig(){return {terminalWsUrl:"ws://127.0.0.1:8831"};}',
          "@/lib/terminal/auth-transport":
            'export async function fetchTerminal(url){return {ok:true,json:async()=>url.includes("session-events") ? {version:1,instanceId:"fixture",startedAt:new Date().toISOString(),generatedAt:new Date().toISOString(),events:[]} : {workspaces:{}}};}',
          "./InteractiveTerminal":
            'export { FixtureTerminal as InteractiveTerminal } from "@/fixtures/window-management";',
        };
        build.onResolve({ filter: /.*/ }, ({ path, importer }) =>
          (path === "./actions" || path === "./subscribe") &&
          importer === resolve("src/lib/push/client.ts")
            ? {
                path: path === "./actions" ? "@/lib/push/actions" : "@/lib/push/subscribe",
                namespace: "mock",
              }
            : path === "./transport" && importer === resolve("src/lib/discovery/queries.ts")
              ? { path: "@/lib/discovery/transport", namespace: "mock" }
              : path in mocks
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
