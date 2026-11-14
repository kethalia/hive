import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cancelTerminalBody, terminalBody, terminalFetch } from "@/lib/terminal/transport-io";
import manifest from "./runtime-artifact-manifest.json";

/** Trusted, build-pinned scripts used by existing workspace operations. */
export async function readRuntimeArtifact(relativePath: string): Promise<string> {
  if (!Object.hasOwn(manifest, relativePath)) throw new Error("Runtime artifact is unavailable");
  const expected = manifest[relativePath as keyof typeof manifest];
  let data: Uint8Array;
  if (process.env.HIVE_RUNTIME_TARGET === "cloudflare") {
    const env = getCloudflareContext().env as { ASSETS?: { fetch: typeof fetch } };
    if (!env.ASSETS) throw new Error("Runtime assets are unavailable");
    const path = relativePath.split("/").map(encodeURIComponent).join("/");
    const signal = AbortSignal.timeout(5000);
    const response = await terminalFetch(
      env.ASSETS.fetch(`https://hive-assets.internal/hive-runtime-artifacts/${path}`, {
        signal,
        redirect: "manual",
      }),
      signal,
    );
    if (response.status !== 200 || response.redirected) {
      await cancelTerminalBody(response);
      throw new Error("Runtime artifact is unavailable");
    }
    data = await terminalBody(response, expected.bytes, signal);
  } else {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    data = await readFile(join(process.cwd(), relativePath));
  }
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(data))).toString(
    "hex",
  );
  if (data.byteLength !== expected.bytes || digest !== expected.sha256)
    throw new Error("Runtime artifact integrity check failed");
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
