export const ORIGIN = "https://hive-app-compatibility-preview.b00ste.workers.dev";
export const LIMIT = 200;
export const DURATION = 180000;
const reads = new Set([
  "/login",
  "/workspaces",
  "/favicon.ico",
  "/manifest.webmanifest",
  "/api/app-version",
  "/api/delivery/tasks",
]);
export function permitted(url, method) {
  let value;
  try {
    value = new URL(url);
  } catch {
    return false;
  }
  if (
    value.origin !== ORIGIN ||
    value.username ||
    value.password ||
    value.hash ||
    /%(?:2f|5c|00)/i.test(value.pathname)
  )
    return false;
  if (method === "POST")
    return (
      value.search === "" &&
      ["/__hive-preview/access", "/api/auth/login", "/api/auth/logout"].includes(value.pathname)
    );
  return (
    method === "GET" &&
    (reads.has(value.pathname) ||
      value.pathname.startsWith("/_next/static/") ||
      /^\/(?:icon|apple-icon)(?:\.[a-z0-9]+)?$/.test(value.pathname))
  );
}
export function createBudget(now = Date.now) {
  const start = now();
  let count = 0;
  const blocked = {};
  return {
    reserve(url, method) {
      const reason =
        now() - start >= DURATION
          ? "deadline"
          : !permitted(url, method)
            ? "scope"
            : count >= LIMIT
              ? "budget"
              : null;
      if (reason) {
        blocked[reason] = (blocked[reason] ?? 0) + 1;
        return false;
      }
      count++;
      return true;
    },
    snapshot() {
      return { forwarded: count, limit: LIMIT, elapsedMs: now() - start, blocked: { ...blocked } };
    },
    remaining() {
      return Math.max(0, DURATION - (now() - start));
    },
  };
}
