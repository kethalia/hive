// Build synthetic React-only fixture in the primary; browser executes elsewhere.

import { writeFileSync } from "node:fs";
import { build } from "esbuild";

const output = process.argv[2];
if (!output?.startsWith("/tmp/")) throw new Error("scratch_output_required");
const result = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import{hydrateRoot}from'react-dom/client';function App(){const[email,setEmail]=useState(''),[password,setPassword]=useState('');return React.createElement('form',{onSubmit:async e=>{e.preventDefault();await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});}},React.createElement('input',{id:'email',type:'email',required:true,value:email,onChange:e=>setEmail(e.target.value)}),React.createElement('input',{id:'password',type:'password',required:true,value:password,onChange:e=>setPassword(e.target.value)}),React.createElement('button',{type:'submit'},'Sign in'));}setTimeout(()=>hydrateRoot(document.getElementById('root'),React.createElement(App)),700);`,
    resolveDir: process.cwd(),
    sourcefile: "synthetic-hydration.jsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
});
writeFileSync(output, result.outputFiles[0].contents, { mode: 0o600 });
