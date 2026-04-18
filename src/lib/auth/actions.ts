"use server";

import { z } from "zod";
import { headers, cookies } from "next/headers";
import { actionClient, authActionClient } from "../safe-action";
import { performLogin } from "./login";
import { deleteSession, setSessionCookie, clearSessionCookie } from "./session";
import { loginRateLimiter } from "./rate-limit";

const loginSchema = z.object({
  coderUrl: z.string().url(),
  email: z.string().email(),
  password: z.string().min(1),
});

export const loginAction = actionClient
  .schema(loginSchema)
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
      const result = await performLogin(coderUrl, email, password);
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
  await deleteSession(ctx.session.sessionId);
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
