import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const root = "/home/coder/projects/kethalia/hive";
const require = createRequire(`${root}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const out = "/tmp/hive-discovery-cache";
await mkdir(out, { recursive: true });
const data = [
  ["software", "ai-dev-01", "ai-dev-k8s", "running"],
  ["browser", "creator-direction-upgrade", "browser-testing", "running"],
  ["infra", "nextcloud-cookbook-infra", "infrastructure", "stopped"],
].map(([id, name, template_name, status]) => ({
  id,
  name,
  template_id: template_name,
  template_name,
  owner_name: "daniel",
  last_used_at: new Date().toISOString(),
  latest_build: { id: `build-${id}`, status },
  health: { healthy: true },
}));
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{GeneralWorkspace}from'${root}/src/components/workspaces/GeneralWorkspace';import{AppSidebar}from'${root}/src/components/app-sidebar';import{SidebarProvider,SidebarInset}from'${root}/src/components/ui/sidebar';import KeybindingProvider from'${root}/src/components/terminal/KeybindingProvider';import{AppViewportSize}from'${root}/src/components/app-viewport-size';import{DashboardKeyboardController}from'${root}/src/components/dashboard-keyboard-controller';import{DiscoveryProvider}from'${root}/src/components/discovery/DiscoveryProvider';window.calls=[];window.mounts={};window.connections=[];window.data=${JSON.stringify(data)};function App(){return <DiscoveryProvider><SidebarProvider style={{height:'100dvh','--app-viewport-height':'100dvh'}}><KeybindingProvider><AppViewportSize/><AppSidebar/><SidebarInset className="h-dvh min-h-0 overflow-hidden"><GeneralWorkspace userId="fixture" initialWorkspaces={window.data}/></SidebarInset><DashboardKeyboardController/></KeybindingProvider></SidebarProvider></DiscoveryProvider>}createRoot(document.getElementById('app')).render(<App/>);`;
await build({
  stdin: { contents: entry, resolveDir: root, loader: "tsx" },
  bundle: true,
  outfile: `${out}/bundle.js`,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: `${root}/tsconfig.json`,
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "fixtures",
      setup(b) {
        b.onResolve({ filter: /^next\/(navigation|link|dynamic)$/ }, (a) => ({
          path: a.path,
          namespace: "mock",
        }));
        b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
          loader: "jsx",
          resolveDir: root,
          contents: a.path.endsWith("link")
            ? `import React from'react';export default function Link({children,...p}){return <a {...p}>{children}</a>}`
            : a.path.endsWith("dynamic")
              ? `import React,{lazy,Suspense}from'react';export default function dynamic(load){const C=lazy(()=>load().then(defaultExport=>({default:defaultExport})));return function Dynamic(p){return <Suspense fallback={null}><C {...p}/></Suspense>}}`
              : `import{useSyncExternalStore}from'react';const router={push(url){history.pushState({},'',url);dispatchEvent(new Event('popstate'))},replace(url){history.replaceState({},'',url);dispatchEvent(new Event('popstate'))},refresh(){}};export const usePathname=()=>'/workspaces';export const useRouter=()=>router;export function useSearchParams(){return new URLSearchParams(useSyncExternalStore(cb=>{addEventListener('popstate',cb);return()=>removeEventListener('popstate',cb)},()=>location.search))}`,
        }));
        b.onLoad({ filter: /src\/lib\/actions\/workspaces\.ts$/ }, () => ({
          loader: "ts",
          contents: `const data=${JSON.stringify(data)};export const listWorkspacesAction=async()=>({data:structuredClone(data)});export const getWorkspaceSessionToolsAction=async(p)=>{window.calls.push({action:"file",...p});return{data:{filesUrl:"https://filebrowser.fixture.invalid/"+p.workspaceId+"/"+p.filePath+"?fresh=1",folderPath:"/projects/"+p.filePath,reloadRequired:false}}};export const getWorkspaceAgentAction=async(p)=>({data:{agentId:p.workspaceId+'-agent',agentName:'main',agentStatus:'connected'}});export const createWorkspaceAction=async()=>({data:{}});export const deleteWorkspaceAction=createWorkspaceAction;export const listWorkspaceTemplatesAction=async()=>({data:[]});export const startWorkspaceAction=async({workspaceId})=>{data.find(w=>w.id===workspaceId).latest_build.status='running';window.calls.push({action:'start',workspaceId});return {data:{}}};export const stopWorkspaceAction=createWorkspaceAction;export const getWorkspaceSessionsAction=async()=>({data:Array.from({length:12},(_,i)=>({name:'terminal-'+i}))});export const createSessionAction=async(p)=>{window.calls.push({action:'create',...p});return{data:{name:p.sessionName??'new-session'}}};export const getWorkspaceAppToolAction=async(p)=>{window.calls.push({action:'app',...p});if(p.workspaceId==='missing')return{serverError:'Not found'};return{data:{url:'https://'+p.tool+'.fixture.invalid/'+p.workspaceId+'?auth=fixture-only'}}};`,
        }));
        b.onLoad({ filter: /src\/lib\/actions\/git-clones\.ts$/ }, () => ({
          loader: "ts",
          contents: `export const listGitClonesAction=async()=>({data:{ok:true,tree:{nodes:[{kind:'repository',id:'hive',label:'hive',cloneSessionKey:'git-clone:projects/kethalia/hive',relativePath:'projects/kethalia/hive'}]}}});export const resolveGitCloneTerminalAction=async(p)=>{window.calls.push({action:'repository',...p});return{data:{sessionName:'git-clone-hive',clonePath:'/tmp/projects/hive',cloneProof:'never-persist'}}};`,
        }));
        b.onLoad({ filter: /src\/lib\/actions\/templates\.ts$/ }, () => ({
          loader: "ts",
          contents: `export const listTemplateStatusesAction=async()=>({data:[]});`,
        }));
        b.onLoad({ filter: /src\/lib\/auth\/actions\.ts$/ }, () => ({
          loader: "ts",
          contents: `export const getSessionAction=async()=>({data:{user:{email:'fixture@example.com',coderUrl:'https://coder.kethalia.com'}}});`,
        }));
        b.onLoad({ filter: /src\/components\/workspaces\/InteractiveTerminal\.tsx$/ }, () => ({
          loader: "tsx",
          resolveDir: root,
          contents: `import React,{useEffect,useRef,useState}from'react';import{createPortal}from'react-dom';import{AudioDeviceControl}from'@/components/terminal/TerminalAudioControls';import{useTerminalFontStep}from'@/hooks/useTerminalFontStep';import{terminalFontSizeScope}from'@/lib/terminal/font-size';export function InteractiveTerminal(p){window.terminalProps??={};window.terminalProps[p.workspaceId]=p;const{size}=useTerminalFontStep(terminalFontSizeScope(p.workspaceId,p.sessionName));const ref=useRef(null);const[slot,setSlot]=useState(null);useEffect(()=>{const key=p.workspaceId+':'+p.sessionName;window.mounts[key]=(window.mounts[key]??0)+1;setSlot(ref.current.closest('[data-terminal-audio-frame]').querySelector('[data-terminal-audio-slot]'))},[]);return <><div ref={ref} data-testid={'terminal-'+p.workspaceId} style={{fontSize:size}} className="p-4 h-full"><p>{p.workspaceId} / {p.sessionName}</p><textarea className="xterm-helper-textarea" aria-label={'Terminal input '+p.workspaceId}/></div>{slot?createPortal(<div className="flex gap-0.5">{['microphone','speaker'].map(device=><AudioDeviceControl key={device} device={device} phase="disconnected" onConnect={()=>window.connections.push(p.workspaceId+':'+device)} onTogglePause={()=>{}} onStop={()=>{}}/>)}</div>,slot):null}</>}`,
        }));
        b.onLoad({ filter: /src\/lib\/actions\/agent-tools\.ts$/ }, () => ({
          loader: "ts",
          contents: `export const configureAgentToolsAction=async()=>({data:{message:'Configured'}});export const resumeAgentSessionAction=async()=>({data:{sessionName:'resumed'}});`,
        }));
      },
    },
  ],
});
const styles = await postcss([tailwind()]).process(
  await readFile(`${root}/src/app/globals.css`, "utf8"),
  { from: `${root}/src/app/globals.css` },
);
await writeFile(`${out}/style.css`, styles.css);
await cp(`${root}/public/fonts`, `${out}/fonts`, { recursive: true });
await writeFile(
  `${out}/index.html`,
  '<!doctype html><html class="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
);
