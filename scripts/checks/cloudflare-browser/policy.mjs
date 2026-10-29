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
  let count = 0,
    loginPosts = 0,
    cleanupUsed = false;
  const blocked = {};
  function reserve(url, method, cleanup) {
    const login = url === `${ORIGIN}/api/auth/login` && method === "POST";
    const reason =
      now() - start >= DURATION
        ? "deadline"
        : !permitted(url, method) ||
            (cleanup && (url !== `${ORIGIN}/api/auth/logout` || method !== "POST"))
          ? "scope"
          : login && loginPosts >= 1
            ? "login_limit"
            : cleanup && cleanupUsed
              ? "cleanup_used"
              : count >= (cleanup ? LIMIT : LIMIT - 1)
                ? "budget"
                : null;
    if (reason) {
      blocked[reason] = (blocked[reason] ?? 0) + 1;
      return false;
    }
    count++;
    if (login) loginPosts++;
    if (cleanup) cleanupUsed = true;
    return true;
  }
  return {
    reserve: (url, method) => reserve(url, method, false),
    reserveCleanup: (url, method) => reserve(url, method, true),
    snapshot() {
      return {
        forwarded: count,
        limit: LIMIT,
        loginPosts,
        cleanupReserved: !cleanupUsed,
        elapsedMs: now() - start,
        blocked: { ...blocked },
      };
    },
    remaining() {
      return Math.max(0, DURATION - (now() - start));
    },
  };
}
/** Caller retains its request context/cookies until this bounded attempt finishes. */
export async function cleanupSession(budget, request) {
  const result = { cleanupAttempted: true, cleanupSucceeded: false };
  const url = `${ORIGIN}/api/auth/logout`;
  if (!budget.reserveCleanup(url, "POST")) return result;
  try {
    const response = await request.post(url, {
      headers: { Origin: ORIGIN },
      maxRedirects: 0,
      maxRetries: 0,
      timeout: Math.max(1, Math.min(5000, budget.remaining())),
    });
    result.cleanupSucceeded = response.status() === 200;
    await response.dispose();
  } catch {}
  return result;
}
