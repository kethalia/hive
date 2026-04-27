"use server";

import { z } from "zod";
import { headers, cookies } from "next/headers";
import { actionClient, authActionClient } from "../safe-action";
import { setSessionCookie, clearSessionCookie } from "./session";
import { loginRateLimiter } from "./rate-limit";
import { getAuthServiceClient } from "./service-client";

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/, /^fe80:/,
];

function validateCoderUrl(raw: string): string {
  const url = new URL(raw);

  const allowlist = process.env.ALLOWED_CODER_URLS;
  if (allowlist) {
    const allowed = allowlist.split(",").map((u) => u.trim().replace(/\/+$/, ""));
    const normalized = `${url.protocol}//${url.host}`;
    if (!allowed.includes(normalized)) {
      throw new Error("Coder URL is not in the allowed list");
    }
    return raw;
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Coder URL must use HTTPS in production");
  }

  const hostname = url.hostname;
  if (hostname === "localhost" && process.env.NODE_ENV === "production") {
    throw new Error("Coder URL cannot target localhost in production");
  }
  if (PRIVATE_IP_PATTERNS.some((re) => re.test(hostname))) {
    throw new Error("Coder URL cannot target private or reserved IP ranges");
  }

  return raw;
}

const loginSchema = z.object({
  coderUrl: z.string().url().transform(validateCoderUrl),
  email: z.string().email(),
  password: z.string().min(1),
});

export const loginAction = actionClient
  .inputSchema(loginSchema)
  .action(async ({ parsedInput: { coderUrl, email, password } }) => {
    const headerStore = await headers();
    const ip =
      headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      headerStore.get("x-real-ip") ??
      "unknown";

    const rateCheck = loginRateLimiter.check(ip);
    if (!rateCheck.allowed) {
      console.log(`[login] Rate limited IP: ${ip}`);
      throw new Error(
        "Too many login attempts. Please try again later."
      );
    }

    try {
      const result = await getAuthServiceClient().login({ coderUrl, email, password });
      const cookieStore = await cookies();
      setSessionCookie(cookieStore, result.sessionId);
      console.log(`[login] Login successful for ${email}`);
      return { success: true as const };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Login failed";
      console.log(`[login] Login failed for ${email}: ${message}`);
      throw new Error(message);
    }
  });

export const logoutAction = authActionClient.action(async ({ ctx }) => {
  await getAuthServiceClient().logout(ctx.session.sessionId);
  const cookieStore = await cookies();
  clearSessionCookie(cookieStore);
  console.log(`[logout] Session deleted for user ${ctx.user.id}`);
  return { success: true as const };
});

export const getSessionAction = authActionClient.action(async ({ ctx }) => {
  return {
    user: {
      id: ctx.user.id,
      email: ctx.user.email,
      coderUrl: ctx.user.coderUrl,
    },
  };
});

export const getTokenStatusAction = authActionClient.action(
  async ({ ctx }) => {
    const result = await getAuthServiceClient().getCredentials(ctx.session.sessionId);
    if (!result) {
      return { status: "expired" as const, expiresAt: null };
    }
    return {
      status: result.status,
      expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
    };
  }
);
