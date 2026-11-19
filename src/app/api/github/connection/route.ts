import { decrypt, encrypt } from "@hive/auth";
import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { publicationBody } from "@/lib/templates/publication-io";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
const statusSchema = z.object({
  authenticated: z.boolean(),
  device: z.boolean(),
  user: z.object({ login: z.string().max(100) }).nullish(),
});
const deviceSchema = z.object({
  verification_uri: z.enum(["https://github.com/login/device", "https://github.com/login/device/"]),
  user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/i),
  device_code: z.string().min(1).max(512),
  expires_in: z.number().int().positive().max(3600),
  interval: z.number().int().min(0).max(120),
});
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("poll"), attempt: z.string().min(1).max(2048) }).strict(),
]);
const proof = z.object({
  purpose: z.literal("github-device"),
  session: z.string(),
  user: z.string(),
  expiresAt: z.number().int(),
  deviceCode: z.string().min(1).max(512),
});

export async function GET(request: Request) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true") return json({}, 404);
  const session = await getRequestSession();
  if (!session) return json({}, 401);
  try {
    const coder = await getCoderClientForUser(session.user.id, { signal: request.signal });
    const status = statusSchema.parse(await coder.getGitHubConnection());
    return json({
      connected: status.authenticated,
      login: status.authenticated ? (status.user?.login ?? null) : null,
      // Coder's browser OAuth path starts reauthorization even for an existing link.
      authorizeUrl: status.device
        ? null
        : new URL("/external-auth/github/callback", coder.getBaseUrl()).href,
    });
  } catch {
    return json({ error: "status_unavailable" }, 502);
  }
}

export async function POST(request: Request) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true") return json({}, 404);
  const origin = process.env.HIVE_PUBLIC_ORIGIN;
  if (
    !origin ||
    new URL(request.url).origin !== origin ||
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    request.headers.get("content-type") !== "application/json"
  )
    return json({}, 403);
  const session = await getRequestSession();
  if (!session) return json({}, 401);
  let input: z.infer<typeof command>;
  try {
    const bytes = await publicationBody(
      new Response(request.body, { headers: request.headers }),
      3072,
      request.signal,
    );
    input = command.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return json({}, 400);
  }
  try {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error();
    const coder = await getCoderClientForUser(session.user.id, { signal: request.signal });
    if (input.action === "start") {
      const device = deviceSchema.parse(await coder.startGitHubDeviceFlow());
      const expiresAt = Date.now() + device.expires_in * 1000;
      const sealed = encrypt(
        JSON.stringify({
          purpose: "github-device",
          session: session.session.id,
          user: session.user.id,
          expiresAt,
          deviceCode: device.device_code,
        }),
        key,
      );
      const attempt = [sealed.iv, sealed.authTag, sealed.ciphertext]
        .map((value) => Buffer.from(value).toString("base64url"))
        .join(".");
      return json({
        attempt,
        userCode: device.user_code,
        verificationUrl: device.verification_uri,
        interval: Math.max(5, device.interval),
        expiresAt,
      });
    }
    let pending: z.infer<typeof proof>;
    try {
      const parts = input.attempt.split(".");
      if (parts.length !== 3) throw new Error();
      const [iv, authTag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
      if (iv.length !== 12 || authTag.length !== 16) throw new Error();
      pending = proof.parse(JSON.parse(decrypt({ iv, authTag, ciphertext }, key)));
    } catch {
      return json({ error: "invalid_attempt" }, 400);
    }
    if (pending.session !== session.session.id || pending.user !== session.user.id)
      return json({}, 403);
    if (pending.expiresAt <= Date.now()) return json({ state: "expired" });
    return json({ state: await coder.exchangeGitHubDeviceCode(pending.deviceCode) });
  } catch {
    return json({ error: "connection_unavailable" }, 502);
  }
}
