import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export function readAcceptanceMaterial(source, { signal } = {}) {
  const bytes = Buffer.from(JSON.stringify(source));
  if (bytes.length > 65536) throw Error("acceptance_material_limit");
  const child = spawn(
    "/usr/bin/python3",
    ["-I", fileURLToPath(new URL("./delivery-acceptance-material.py", import.meta.url))],
    { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "ignore"] },
  );
  return new Promise((resolve, reject) => {
    let failed = false,
      total = 0;
    const chunks = [];
    const stop = () => {
      failed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 10000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (total > 200000) stop();
      else chunks.push(chunk);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (failed || code !== 0) return reject(Error("acceptance_material_unavailable"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Error("acceptance_material_unavailable"));
      }
    });
    child.stdin.end(bytes);
  });
}
