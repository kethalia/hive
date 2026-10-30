import {
  AuthServiceClient,
  authServiceHeaders,
  sessionCookieValues,
  verifyCookie,
} from "@hive/auth";
import { z } from "zod";
import {
  cancelPublicationBody,
  publicationBody,
  publicationFetch,
} from "@/lib/templates/publication-io";

export type GenericTerminalAuthEnvironment = {
  AUTH_SERVICE?: { fetch: typeof fetch };
  AUTH_SERVICE_SECRET?: string;
  COOKIE_SECRET?: string;
  CODER_URL?: string;
};
export class GenericTerminalFailure extends Error {
  constructor(public readonly closeCode: 4401 | 4403 | 4404) {
    super("terminal_authorization");
  }
}
export const genericTerminalSessionSchema = z.object({
  userId: z.string().uuid(),
  coderUserId: z.string().uuid(),
  coderUrl: z.string(),
  sessionId: z.string(),
  expiresAt: z.string(),
});
/** Captures only this request's binding. Headers/body/cancellation share the same
 * deadline; no encrypted credential access or DB context belongs to the relay. */
export function genericTerminalAuthClient(
  env: GenericTerminalAuthEnvironment,
  signal: AbortSignal,
) {
  const binding = env.AUTH_SERVICE;
  if (
    !binding ||
    typeof binding.fetch !== "function" ||
    typeof env.AUTH_SERVICE_SECRET !== "string"
  )
    throw new Error("auth");
  authServiceHeaders(env.AUTH_SERVICE_SECRET);
  return new AuthServiceClient("https://hive-auth.internal", 5000, {
    serviceSecret: env.AUTH_SERVICE_SECRET,
    fetch: async (input, init) => {
      const combined = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
      const response = await publicationFetch(
        binding.fetch(input, { ...init, signal: combined }),
        combined,
      );
      if (response.status !== 200 || response.redirected) {
        await cancelPublicationBody(response);
        if (response.status === 401 || response.status === 404)
          throw new GenericTerminalFailure(4401);
        throw new Error("auth");
      }
      return new Response(new Uint8Array(await publicationBody(response, 65536, combined)).buffer, {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}
export async function genericTerminalIssuerSession(
  request: Request,
  env: GenericTerminalAuthEnvironment,
) {
  const values = sessionCookieValues(request.headers.get("Cookie") ?? undefined);
  if (values.length !== 1 || !env.COOKIE_SECRET) return null;
  const cookie = verifyCookie(values[0], env.COOKIE_SECRET);
  if (!cookie) return null;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const session = genericTerminalSessionSchema.parse(
    await genericTerminalAuthClient(env, signal).getSession(cookie.sessionId),
  );
  const expiry = Date.parse(session.expiresAt);
  if (
    session.sessionId !== cookie.sessionId ||
    session.coderUrl !== env.CODER_URL ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now()
  )
    return null;
  return { session: { sessionId: session.sessionId, expiresAt: new Date(expiry) } };
}
