// Phase A only. The primary supplies a reviewed fresh scope; this is a network
// budget and test guard, never application authorization or a task permission.
export const ORIGIN = "https://hive-app-compatibility-preview.b00ste.workers.dev";
export const TARGET = Object.freeze({
  workspaceId: "22c4f094-46f0-4a76-86ca-37ad74254872",
  repositoryId: "1183966024",
  providerAccountId: "62855857",
});
export const LIMIT = 200,
  DURATION = 180000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseScope(value) {
  const keys = [
    "schemaVersion",
    "sourceRevision",
    "workspaceId",
    "repositoryId",
    "providerAccountId",
    "preflightDigest",
    "expectedAppVersion",
    "expectedAppBuild",
    "priorForwarded",
  ];
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join() ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.priorForwarded) ||
    value.priorForwarded < 0 ||
    value.priorForwarded > 198 ||
    !/^[a-f0-9]{40}$/.test(value.sourceRevision) ||
    !uuid.test(value.workspaceId) ||
    !/^[a-f0-9]{64}$/.test(value.preflightDigest) ||
    ![value.repositoryId, value.providerAccountId].every(
      (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v),
    ) ||
    ![value.expectedAppVersion, value.expectedAppBuild].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(v),
    )
  )
    throw new Error("scope_rejected");
  if (Object.entries(TARGET).some(([key, expected]) => value[key] !== expected))
    throw new Error("scope_rejected");
  return Object.freeze({ ...value });
}
function exact(params, keys) {
  return [...params.keys()].sort().join() === keys.slice().sort().join();
}
export function permitted(scope, input, method, headers = {}, body = "") {
  try {
    const url = new URL(input),
      h = new Headers(headers);
    if (
      url.origin !== ORIGIN ||
      url.username ||
      url.password ||
      url.hash ||
      /%(?:2f|5c|00)/i.test(url.pathname) ||
      h.has("Next-Action") ||
      h.has("Content-Encoding") ||
      h.has("Upgrade")
    )
      return false;
    if (h.has("Authorization") && !(method === "POST" && url.pathname === "/__hive-preview/access"))
      return false;
    if (method === "POST") {
      if (url.search) return false;
      if (["/__hive-preview/access", "/api/auth/logout"].includes(url.pathname)) return true;
      if (typeof body !== "string" || Buffer.byteLength(body) > 4096) return false;
      const data = JSON.parse(body);
      if (!data || Array.isArray(data)) return false;
      if (url.pathname === "/api/auth/login")
        return (
          Object.keys(data).sort().join() === "email,password" &&
          typeof data.email === "string" &&
          typeof data.password === "string"
        );
      return (
        url.pathname === "/api/projects/open" &&
        Object.keys(data).sort().join() ===
          "providerAccountId,repositoryId,requestId,workspaceId" &&
        data.workspaceId === scope.workspaceId &&
        data.repositoryId === scope.repositoryId &&
        data.providerAccountId === scope.providerAccountId &&
        uuid.test(data.requestId)
      );
    }
    if (method !== "GET") return false;
    if (url.pathname === "/")
      return (
        !url.search ||
        (exact(url.searchParams, ["_rsc"]) &&
          /^[A-Za-z0-9_-]{1,120}$/.test(url.searchParams.get("_rsc")))
      );
    if (
      [
        "/login",
        "/favicon.ico",
        "/manifest.webmanifest",
        "/api/app-version",
        "/icons/hive-mark.svg",
        "/apple-touch-icon.png",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/icon-maskable-192.png",
        "/icons/icon-maskable-512.png",
        "/fonts/FiraCode-Regular.ttf",
        "/fonts/FiraCode-Medium.ttf",
      ].includes(url.pathname)
    )
      return !url.search;
    if (
      url.pathname.startsWith("/_next/static/") ||
      /^\/(?:icon|apple-icon)(?:\.[a-z0-9]+)?$/.test(url.pathname)
    )
      return !url.search && !url.pathname.includes("..");
    if (url.pathname === "/workspaces")
      return (
        !url.search ||
        (exact(url.searchParams, ["_rsc"]) &&
          /^[A-Za-z0-9_-]{1,120}$/.test(url.searchParams.get("_rsc"))) ||
        (exact(url.searchParams, ["panel", "workspace"]) &&
          url.searchParams.get("panel") === "projects" &&
          url.searchParams.get("workspace") === scope.workspaceId)
      );
    if (["/api/discovery/workspaces", "/api/discovery/template-options"].includes(url.pathname))
      return (
        !url.search ||
        (exact(url.searchParams, ["refresh"]) && url.searchParams.get("refresh") === "1")
      );
    if (url.pathname === "/api/discovery/agent")
      return (
        (exact(url.searchParams, ["workspaceId"]) ||
          exact(url.searchParams, ["workspaceId", "refresh"])) &&
        url.searchParams.get("workspaceId") === scope.workspaceId &&
        (!url.searchParams.has("refresh") || url.searchParams.get("refresh") === "1")
      );
    return (
      url.pathname === "/api/projects" &&
      exact(url.searchParams, ["workspaceId", "page", "perPage"]) &&
      url.searchParams.get("workspaceId") === scope.workspaceId &&
      /^[1-4]$/.test(url.searchParams.get("page")) &&
      url.searchParams.get("perPage") === "100"
    );
  } catch {
    return false;
  }
}
export function createBudget(scope, now = Date.now, { durationMs = DURATION } = {}) {
  scope = parseScope(scope);
  const priorForwarded = scope.priorForwarded;
  if (
    !Number.isSafeInteger(priorForwarded) ||
    priorForwarded < 0 ||
    priorForwarded >= LIMIT ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > DURATION
  )
    throw new Error("budget_rejected");
  const started = now();
  let count = priorForwarded,
    login = 0,
    open = 0,
    pages = 0,
    cleanup = false;
  const blocked = {};
  function reserve(url, method, headers = {}, body = "", isCleanup = false) {
    const target = new URL(url),
      isLogin = method === "POST" && target.pathname === "/api/auth/login",
      isOpen = method === "POST" && target.pathname === "/api/projects/open",
      isPage = target.pathname === "/api/projects";
    const reason =
      now() - started >= durationMs
        ? "deadline"
        : !permitted(scope, url, method, headers, body)
          ? "scope"
          : isCleanup && (url !== `${ORIGIN}/api/auth/logout` || method !== "POST")
            ? "cleanup_scope"
            : isLogin && login >= 1
              ? "login_limit"
              : isOpen && open >= 1
                ? "open_limit"
                : isPage && pages >= 4
                  ? "page_limit"
                  : isCleanup && cleanup
                    ? "cleanup_used"
                    : count >= (isCleanup ? LIMIT : LIMIT - 1)
                      ? "budget"
                      : null;
    if (reason) {
      blocked[reason] = (blocked[reason] ?? 0) + 1;
      return false;
    }
    count++;
    if (isLogin) login++;
    if (isOpen) open++;
    if (isPage) pages++;
    if (isCleanup) cleanup = true;
    return true;
  }
  return {
    reserve: (...args) => reserve(...args),
    reserveCleanup: () => reserve(`${ORIGIN}/api/auth/logout`, "POST", {}, "", true),
    remaining: () => Math.max(0, durationMs - (now() - started)),
    snapshot: () => ({
      forwarded: count - priorForwarded,
      cumulativeForwarded: count,
      priorForwarded,
      limit: LIMIT,
      elapsedMs: now() - started,
      loginPosts: login,
      openPosts: open,
      repositoryReads: pages,
      blocked: { ...blocked },
    }),
  };
}
