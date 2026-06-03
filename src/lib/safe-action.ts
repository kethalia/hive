import { createSafeActionClient } from "next-safe-action";
import { getRequestSession, type SessionData } from "@/lib/auth/session";

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
  const session = await getRequestSession();

  if (!session) {
    throw new Error("Not authenticated");
  }

  return next({
    ctx: session satisfies SessionData,
  });
});
