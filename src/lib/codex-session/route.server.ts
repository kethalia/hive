import { getDb } from "@hive/db";
import { getRequestSession } from "@/lib/auth/session";
import {
  createRegisteredSessionService,
  registeredSessionConfig,
} from "./registered-session.server";
export const sessionResponseHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export const sessionError = (error: string, status: number) =>
  Response.json({ error }, { status, headers: sessionResponseHeaders });
export function sessionService() {
  return createRegisteredSessionService(getDb(), registeredSessionConfig());
}
export async function boundedSessionJson(request: Request, limit = 65536) {
  if (
    request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
    request.headers.get("content-encoding")
  )
    throw new Error("invalid_request");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new Error("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 5000;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timeout")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) break;
      size += result.value.length;
      if (size > limit || chunks.length >= 1024) throw new Error("invalid_request");
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 100);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
export async function authorizeSessionOwner(request: Request) {
  if (process.env.HIVE_CODEX_GATEWAY_ENABLED !== "true")
    return sessionError("session_disabled", 404);
  const config = registeredSessionConfig();
  if (
    request.headers.get("origin") !== config.hiveOrigin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return sessionError("invalid_origin", 403);
  return (await getRequestSession()) ?? sessionError("not_authenticated", 401);
}
