// Phase A only. The primary supplies a reviewed fresh scope; this is a network
// budget and test guard, never application authorization or a task permission.
export const ORIGIN = "https://hive-app-compatibility-preview.b00ste.workers.dev";
export const NATIVE_ORIGIN = "https://codex-delivery-system-design-hive.b00ste.workers.dev";
export const NATIVE_WORKSPACE = "5390bdfc-b004-4489-96c8-2b9f1de20f1f";
// Add a new exact pair only after the primary preserves its creation identity.
// No caller-supplied origin or workspace selector can extend this registry.
export const NATIVE_TARGETS = Object.freeze([
  Object.freeze({ workspaceId: NATIVE_WORKSPACE, origin: NATIVE_ORIGIN }),
  // Primary creation record: d11-native-final-workspace-creation.json.
  // Registry membership does not assert host health or authorize enrollment.
  Object.freeze({ workspaceId: "e6aa588f-89a7-464b-9cf9-a6371d0b819d", origin: NATIVE_ORIGIN }),
]);
export const TARGET = Object.freeze({
  workspaceId: "22c4f094-46f0-4a76-86ca-37ad74254872",
  repositoryId: "1183966024",
  providerAccountId: "62855857",
});
const REVIEWED_WORKSPACES = Object.freeze([
  TARGET.workspaceId,
  "49dfbaf2-f475-4053-8c6b-2fc09d0db8bf",
]);
export const LIMIT = 200,
  DURATION = 180000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function originForScope(scope) {
  if (REVIEWED_WORKSPACES.includes(scope.workspaceId)) return ORIGIN;
  const target = NATIVE_TARGETS.find((pair) => pair.workspaceId === scope.workspaceId);
  if (target) return target.origin;
  throw new Error("scope_rejected");
}
export function isNativeScope(scope) {
  const origin = originForScope(scope);
  return NATIVE_TARGETS.some(
    (pair) => pair.workspaceId === scope.workspaceId && pair.origin === origin,
  );
}
export function parsePreviewAuth(scope, auth) {
  if (isNativeScope(scope)) {
    if (
      !auth ||
      typeof auth !== "object" ||
      Array.isArray(auth) ||
      Object.keys(auth).join() !== "cookies" ||
      !Array.isArray(auth.cookies) ||
      auth.cookies.length !== 1
    )
      throw new Error("auth_rejected");
    const cookie = auth.cookies[0];
    if (
      !cookie ||
      typeof cookie !== "object" ||
      Array.isArray(cookie) ||
      Object.keys(cookie).sort().join() !== "name,value" ||
      cookie.name !== "__Host-hive-session" ||
      typeof cookie.value !== "string" ||
      !cookie.value ||
      cookie.value.length > 4096 ||
      !/^[A-Za-z0-9._~-]+$/.test(cookie.value)
    )
      throw new Error("auth_rejected");
    return { cookies: [{ name: cookie.name, value: cookie.value }] };
  }
  const keys = ["email", "password", "previewBearer"];
  if (
    !auth ||
    typeof auth !== "object" ||
    Array.isArray(auth) ||
    Object.keys(auth).sort().join() !== keys.sort().join() ||
    typeof auth.email !== "string" ||
    auth.email.length > 254 ||
    typeof auth.password !== "string" ||
    auth.password.length > 2048 ||
    typeof auth.previewBearer !== "string" ||
    !/^[a-f0-9]{64}$/.test(auth.previewBearer)
  )
    throw new Error("auth_rejected");
  return auth;
}
export function parseScope(value, { allowNative = false } = {}) {
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
  if (
    !(
      REVIEWED_WORKSPACES.includes(value.workspaceId) ||
      (allowNative && NATIVE_TARGETS.some((pair) => pair.workspaceId === value.workspaceId))
    ) ||
    value.repositoryId !== TARGET.repositoryId ||
    value.providerAccountId !== TARGET.providerAccountId
  )
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
      url.origin !== originForScope(scope) ||
      url.username ||
      url.password ||
      url.hash ||
      /%(?:2f|5c|00)/i.test(url.pathname) ||
      h.has("Next-Action") ||
      h.has("Content-Encoding") ||
      h.has("Upgrade")
    )
      return false;
    const privateAccess = !isNativeScope(scope);
    if (
      h.has("Authorization") &&
      !(privateAccess && method === "POST" && url.pathname === "/__hive-preview/access")
    )
      return false;
    if (method === "POST") {
      if (url.search) return false;
      if (url.pathname === "/__hive-preview/access") return privateAccess;
      if (url.pathname === "/api/auth/logout") return true;
      if (typeof body !== "string" || Buffer.byteLength(body) > 4096) return false;
      const data = JSON.parse(body);
      if (!data || Array.isArray(data)) return false;
      if (url.pathname === "/api/auth/login")
        return (
          privateAccess &&
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
