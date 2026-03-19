import { createSafeActionClient } from "next-safe-action";

/**
 * Public action client — no auth required.
 * Hive is a solo-operator tool (no multi-user auth).
 */
export const actionClient = createSafeActionClient({
  handleServerError: (error) => {
    console.error("[action] Server error:", error.message);
    return error.message;
  },
});
