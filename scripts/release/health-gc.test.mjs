import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

test("a collected fetch request cannot detach the shared response-body deadline", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-health-gc-"));
  try {
    const output = join(dir, "health.mjs");
    buildSync({
      entryPoints: [resolve("deploy/cloudflare/app/release-health.ts")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
    });
    const script = `import {releaseAuthReadiness} from ${JSON.stringify(pathToFileURL(output).href)};
      let signal, canceled=false, error;
      const gcTimer=setInterval(()=>global.gc(),10);
      try {
        await releaseAuthReadiness(async request=>{
          signal=request.signal;
          return new Response(new ReadableStream({cancel(){canceled=true;}}));
        },'a'.repeat(64),new AbortController().signal,300);
      } catch(e) {error=e.message;} finally {clearInterval(gcTimer);}
      await new Promise(resolve=>setTimeout(resolve,0));
      console.log(JSON.stringify({aborted:signal?.aborted,canceled,error}));`;
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      aborted: true,
      canceled: true,
      error: "release_probe_aborted",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
