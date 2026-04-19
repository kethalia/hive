import { createSafeActionClient } from "next-safe-action";
import { cookies } from "next/headers";
import { getSession, type SessionData } from "./auth/session";

export const actionClient = createSafeActionClient({
  handleServerError: (error) => {
    console.error("[action] Server error:", error.message);
    return error.message;
  },
});

export const authActionClient = createSafeActionClient({
  handleServerError: (error) => {
    if (error.message !== "Not authenticated") {
      console.error("[action] Server error:", error.message);
    }
    return error.message;
  },
}).use(async ({ next }) => {
  const cookieStore = await cookies();
  const session = await getSession(cookieStore);

  if (!session) {
    throw new Error("Not authenticated");
  }

  return next({
    ctx: session satisfies SessionData,
  });
});
