export type PortableActions = {
  schemaVersion: number;
  actions: Record<string, { paths: readonly string[]; maxBodyBytes: number }>;
};

const bodyLimits = new Set([65536, 786432]);

/** Runtime compatibility only: Next's CSRF, authentication, input validation and
 * current Coder authorization still run. Action IDs come from this exact build. */
export function isPortableServerAction(request: Request, manifest: PortableActions): boolean {
  if (manifest.schemaVersion !== 1 || request.method !== "POST") return false;
  const id = request.headers.get("Next-Action");
  if (!id || !/^[0-7][a-f0-9]{41}$/.test(id) || !Object.hasOwn(manifest.actions, id)) return false;
  const url = new URL(request.url);
  const length = request.headers.get("Content-Length");
  const limit = manifest.actions[id].maxBodyBytes;
  return (
    bodyLimits.has(limit) &&
    !request.url.includes("?") &&
    !url.hash &&
    !url.pathname.includes("%") &&
    manifest.actions[id].paths.includes(url.pathname) &&
    request.headers.get("Origin") === url.origin &&
    (!request.headers.has("Sec-Fetch-Site") ||
      request.headers.get("Sec-Fetch-Site") === "same-origin") &&
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "text/plain" &&
    !request.headers.has("Content-Encoding") &&
    !request.headers.has("Upgrade") &&
    (length === null || (/^\d+$/.test(length) && Number(length) <= limit))
  );
}

/** Admit the complete bounded body before framework/DB dispatch. Content-Length
 * alone is insufficient for streamed requests. Preserve the exact action bytes,
 * headers and caller cancellation when rebuilding the consumed request. */
export async function boundPortableActionBody(
  request: Request,
  manifest: PortableActions,
): Promise<Request | Response> {
  const reject = (status: number) =>
    Response.json(
      { error: "Portable action request body rejected." },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  if (!isPortableServerAction(request, manifest)) return reject(400);
  if (request.signal.aborted) return reject(408);
  if (!request.body)
    return Number(request.headers.get("Content-Length") ?? 0) === 0 ? request : reject(400);
  const limit = manifest.actions[request.headers.get("Next-Action") ?? ""]?.maxBodyBytes;
  if (typeof limit !== "number" || !bodyLimits.has(limit)) return reject(400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let status = 400;
  let onAbort: (() => void) | undefined;
  try {
    const bytes = await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (let count = 0; count < 4096 && !stopped; count++) {
          const part = await reader.read();
          if (stopped) throw new Error("body_stopped");
          if (part.done) {
            const declared = request.headers.get("Content-Length");
            if (declared !== null && Number(declared) !== length)
              throw new Error("body_length_mismatch");
            const result = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return result;
          }
          length += part.value.byteLength;
          if (length > limit) {
            status = 413;
            throw new Error("body_limit");
          }
          // Own the bytes; a producer must not mutate an earlier chunk later.
          chunks.push(new Uint8Array(part.value));
        }
        throw new Error("body_chunk_limit");
      })(),
      new Promise<never>((_resolve, rejectRead) => {
        const stop = () => {
          status = 408;
          stopped = true;
          rejectRead(new Error("body_stopped"));
        };
        timer = setTimeout(stop, 5000);
        onAbort = stop;
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
      }),
    ]);
    if (request.signal.aborted) return reject(408);
    return new Request(request, { body: bytes, signal: request.signal });
  } catch {
    return reject(status);
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    // A custom stream may never settle cancel(); rejection still has a deadline.
    await Promise.race([
      reader.cancel().catch(() => {}),
      new Promise<void>((resolve) => {
        cancelTimer = setTimeout(resolve, 100);
      }),
    ]);
    clearTimeout(cancelTimer);
  }
}

const discoveryPaths = new Set([
  "/api/discovery/workspaces",
  "/api/discovery/template-options",
  "/api/discovery/agent",
  "/api/discovery/templates",
]);
export function isPortableDiscovery(request: Request): boolean {
  return request.method === "GET" && discoveryPaths.has(new URL(request.url).pathname);
}

export function isUnsupportedPageMutation(request: Request, manifest: PortableActions): boolean {
  // Next also dispatches headerless multipart/$ACTION_ID forms. They must not
  // bypass the export allowlist merely by omitting the Next-Action header.
  return (
    !new URL(request.url).pathname.startsWith("/api/") &&
    !["GET", "HEAD"].includes(request.method) &&
    !isPortableServerAction(request, manifest)
  );
}
