// Browser Testing only. All credentials and task text stay in memory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import {
  parsePhaseB,
  phaseBFrame,
  phaseBHasBudget,
  phaseBMarkerItems,
  phaseBPermit,
  phaseBSocket,
} from "./phase-b-policy.mjs";
import { isNativeScope, originForScope, parsePreviewAuth } from "./policy.mjs";

assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "browser");
assert.deepEqual(process.argv.slice(2), ["--run"]);
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 16384) throw Error("input");
}
const input = JSON.parse(raw);
raw = "";
assert.deepEqual(Object.keys(input).sort(), ["auth", "scope"]);
const scope = parsePhaseB(input.scope),
  auth = parsePreviewAuth(scope, input.auth),
  nativePublicLogin = isNativeScope(scope),
  origin = originForScope(scope);
const deadline = Date.now() + 180000,
  checks = {},
  counts = {
    forwarded: scope.priorForwarded,
    sockets: 0,
    sessionGrants: 0,
    terminalGrants: 0,
    starts: 0,
    logins: 0,
    opens: 0,
  };
let browser,
  context,
  page,
  sessionSocket,
  failed = false,
  nativeSessionInjected = false,
  stage = "launch",
  cleanup = false,
  markerBefore = new Set(),
  markerAfter = new Set(),
  terminalReady = false,
  taskThread,
  forced = false,
  observedBinding,
  timer;
const check = (value) => {
  if (!value) throw Error("check_failed");
};
function reserve(url, method, headers = {}, body = "", isCleanup = false) {
  if (
    Date.now() >= deadline ||
    !phaseBHasBudget(scope, counts.forwarded, isCleanup) ||
    !phaseBPermit(scope, url, method, headers, body)
  )
    return false;
  const path = new URL(url).pathname;
  if (path === "/api/auth/login" && ++counts.logins > 1) return false;
  if (path === "/api/projects/open" && ++counts.opens > 1) return false;
  if (path.endsWith("/tasks/start") && ++counts.starts > 1) return false;
  counts.forwarded++;
  return true;
}
try {
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    timeout: 10000,
    args: [
      "--no-sandbox",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
    ],
  });
  timer = setTimeout(
    () => {
      failed = true;
      void browser.close();
    },
    Math.max(1, deadline - Date.now()),
  );
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
  });
  context.setDefaultTimeout(12000);
  context.on("page", (opened) => {
    if (page && opened !== page) {
      failed = true;
      void opened.close();
    }
  });
  await context.routeWebSocket("**/*", (ws) => {
    if (!phaseBSocket(scope, ws.url()) || Date.now() >= deadline || ++counts.sockets > 6) {
      failed = true;
      ws.close();
      return;
    }
    const kind = new URL(ws.url()).pathname.endsWith("/session") ? "session" : "terminal";
    const server = ws.connectToServer();
    if (kind === "session") sessionSocket = server;
    ws.onMessage((data) => {
      if (!phaseBFrame(kind, data)) {
        failed = true;
        ws.close();
        server.close();
        return;
      }
      server.send(data);
    });
    server.onMessage((data) => {
      if (kind === "session")
        for (const pair of phaseBMarkerItems(data, scope.marker))
          (forced ? markerAfter : markerBefore).add(JSON.stringify(pair));
      if (kind === "terminal" && typeof data === "string") {
        try {
          if (JSON.parse(data)?.type === "ready") terminalReady = true;
        } catch {}
      }
      ws.send(data);
    });
  });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = req.url(),
      method = req.method(),
      headers = req.headers(),
      body = req.postData() ?? "";
    if (!reserve(url, method, headers, body)) {
      failed = true;
      await route.abort();
      return;
    }
    try {
      if (new URL(url).pathname === "/api/auth/login") {
        const v = JSON.parse(body);
        check(v.email === auth.email && v.password === auth.password);
      }
      const res = await route.fetch({
        maxRedirects: 0,
        maxRetries: 0,
        timeout: Math.max(1, Math.min(10000, deadline - Date.now())),
      });
      const location = res.headers().location;
      if (
        res.status() >= 300 &&
        res.status() < 400 &&
        location &&
        !phaseBPermit(scope, new URL(location, url).href, "GET")
      )
        throw Error("redirect");
      const path = new URL(url).pathname;
      if (path === "/api/projects/open" && res.status() === 200) {
        const v = await res.json();
        check(
          v.projectId === scope.projectId &&
            v.workspaceId === scope.workspaceId &&
            v.providerAccountId === scope.providerAccountId &&
            v.repository?.providerRepositoryId === scope.repositoryId &&
            v.repository?.fullName === "kethalia/hive",
        );
        if (scope.start) check(v.currentTaskId === null && v.nativeThreadId === null);
        else check(v.currentTaskId === scope.taskId && v.nativeThreadId === scope.threadId);
        checks.projectBound = true;
      }
      if (path.endsWith("/tasks/status") && res.ok()) {
        const status = await res.json();
        check(status.projectId === scope.projectId && status.taskId === scope.taskId);
        if (status.nativeThreadId) {
          if (taskThread) check(taskThread === status.nativeThreadId);
          taskThread = status.nativeThreadId;
          if (scope.threadId) check(scope.threadId === taskThread);
        }
      }
      if (path.endsWith("/tasks/start") && res.ok()) {
        const v = await res.json();
        check(
          v.projectId === scope.projectId &&
            typeof v.taskId === "string" &&
            /^[a-f0-9-]{36}$/.test(v.taskId),
        );
        scope.taskId = v.taskId;
      }
      if ((path.endsWith("/session-grant") || path.endsWith("/terminal-grant")) && res.ok()) {
        const grant = await res.json(),
          b = grant.binding;
        check(
          b?.ownerId === scope.ownerId &&
            b.workspaceId === scope.workspaceId &&
            b.buildId === scope.buildId &&
            typeof b.serverInstanceId === "string" &&
            typeof b.threadId === "string",
        );
        if (taskThread) check(taskThread === b.threadId);
        if (observedBinding) check(JSON.stringify(b) === JSON.stringify(observedBinding));
        else {
          if (scope.serverInstanceId)
            check(b.serverInstanceId === scope.serverInstanceId && b.threadId === scope.threadId);
          observedBinding = b;
          scope.serverInstanceId = b.serverInstanceId;
          scope.threadId = b.threadId;
        }
        if (path.endsWith("/session-grant")) counts.sessionGrants++;
        else counts.terminalGrants++;
      }
      await route.fulfill({ response: res });
      await res.dispose();
    } catch {
      failed = true;
      await route.abort().catch(() => {});
    }
  });
  if (!nativePublicLogin) {
    stage = "bootstrap";
    check(
      reserve(`${origin}/__hive-preview/access`, "POST", {
        Authorization: `Bearer ${auth.previewBearer}`,
      }),
    );
    const bootstrap = await context.request.post(`${origin}/__hive-preview/access`, {
      headers: { Authorization: `Bearer ${auth.previewBearer}`, Origin: origin },
      maxRedirects: 0,
      timeout: 10000,
    });
    check(bootstrap.status() === 204);
    await bootstrap.dispose();
    auth.previewBearer = "";
  }
  stage = "login";
  page = await context.newPage();
  page.on("pageerror", () => {
    failed = true;
  });
  page.on("download", (d) => {
    failed = true;
    void d.cancel();
  });
  if (nativePublicLogin) {
    await context.addCookies(
      auth.cookies.map((cookie) => ({
        ...cookie,
        url: origin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      })),
    );
    nativeSessionInjected = true;
    for (const cookie of auth.cookies) cookie.value = "";
    auth.cookies = [];
    await page.goto(`${origin}/workspaces`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-dashboard-main]").waitFor();
    checks.injectedHiveSessionWithoutCoderCredentials = true;
  } else {
    await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const f = document.querySelector("form");
      return (
        f &&
        Object.keys(f)
          .filter((k) => k.startsWith("__reactProps$"))
          .some((k) => typeof f[k]?.onSubmit === "function")
      );
    });
    await page.locator("#email").fill(auth.email);
    await page.locator("#password").fill(auth.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("[data-dashboard-main]").waitFor();
    auth.email = "";
    auth.password = "";
  }
  stage = "version";
  check(reserve(`${origin}/api/app-version`, "GET"));
  const version = await context.request.get(`${origin}/api/app-version`);
  const v = await version.json();
  check(
    version.ok() && v.version === scope.expectedAppVersion && v.buildId === scope.expectedAppBuild,
  );
  await version.dispose();
  stage = "project";
  await page.goto(`${origin}/workspaces?panel=projects&workspace=${scope.workspaceId}`, {
    waitUntil: "domcontentloaded",
  });
  const region = page.getByRole("region", { name: "GitHub projects", exact: true });
  await region.waitFor();
  const search = region.getByLabel("Search loaded repositories", { exact: true });
  await search.fill("kethalia/hive");
  const repository = region.getByRole("button", { name: "kethalia/hive", exact: true });
  for (let n = 1; n < 4 && !(await repository.isVisible().catch(() => false)); n++) {
    const next = region.getByRole("button", { name: "Load more repositories", exact: true });
    if (!(await next.isVisible().catch(() => false))) break;
    const loaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/projects" && r.status() === 200,
    );
    await next.click();
    await loaded;
  }
  await repository.click();
  const project = page.getByRole("region", { name: "Project kethalia/hive", exact: true });
  await project.waitFor();
  if (scope.start) {
    stage = "start";
    await project
      .getByRole("textbox", { name: "What do you need?", exact: true })
      .fill(scope.start.text);
    await project.getByRole("button", { name: "Start task", exact: true }).click();
  }
  stage = "conversation";
  await project
    .getByRole("region", { name: "Codex conversation", exact: true })
    .waitFor({ timeout: 90000 });
  await project.getByText("Connected", { exact: true }).waitFor();
  const history = project.getByRole("region", { name: "Conversation history", exact: true });
  const response = history.getByRole("article", { name: "Codex message", exact: true });
  await response.getByText(scope.marker, { exact: false }).first().waitFor({ timeout: 90000 });
  const before = await response.getByText(scope.marker, { exact: false }).count();
  check(
    checks.projectBound === true &&
      before === 1 &&
      counts.sessionGrants >= 1 &&
      markerBefore.size === 1,
  );
  checks.conversationMarkerOnce = true;
  stage = "terminal";
  await project.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector(".xterm-screen"));
  for (let n = 0; n < 100 && !terminalReady; n++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  check(counts.terminalGrants >= 1 && terminalReady);
  checks.terminalAttached = true;
  await project.getByRole("button", { name: "Conversation", exact: true }).click();
  stage = "reconnect";
  check(sessionSocket);
  forced = true;
  sessionSocket.close();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Codex conversation"]')
        ?.textContent?.includes("Connected"),
    null,
    { timeout: 30000 },
  );
  await response.getByText(scope.marker, { exact: false }).first().waitFor({ timeout: 30000 });
  for (let n = 0; n < 300 && (counts.sessionGrants < 2 || markerAfter.size < 1); n++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    (await response.getByText(scope.marker, { exact: false }).count()) === 1 &&
      counts.sessionGrants >= 2 &&
      markerAfter.size === 1 &&
      [...markerBefore][0] === [...markerAfter][0] &&
      !failed,
  );
  checks.reconnectedMarkerOnce = true;
  checks.sameTurnAndItem = true;
  checks.sessionAndTerminalBindingsMatch = true;
  stage = "complete";
} catch {
  failed = true;
} finally {
  if (
    context &&
    (counts.logins || nativeSessionInjected) &&
    Date.now() < deadline &&
    reserve(`${origin}/api/auth/logout`, "POST", {}, "", true)
  ) {
    try {
      const r = await context.request.post(`${origin}/api/auth/logout`, {
        headers: { Origin: origin },
        maxRedirects: 0,
        timeout: 5000,
      });
      cleanup = r.status() === 200;
      await r.dispose();
    } catch {}
  }
  clearTimeout(timer);
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
console.log(
  JSON.stringify({
    schemaVersion: 1,
    phase: "B",
    passed: !failed && stage === "complete" && cleanup,
    stage,
    sourceRevision: scope.sourceRevision,
    preflightDigest: scope.preflightDigest,
    previewAccessRequired: !nativePublicLogin,
    projectId: scope.projectId,
    taskId: scope.taskId,
    observedBinding,
    checks,
    markerIdentityDigest:
      markerBefore.size === 1
        ? createHash("sha256")
            .update([...markerBefore][0])
            .digest("hex")
        : null,
    counts,
    cleanupSucceeded: cleanup,
    hostIdentityIndependentlyJoined: false,
    nativeProcessCountProven: false,
    screenshots: false,
    transcriptsExported: false,
  }),
);
if (failed || !cleanup) process.exitCode = 1;
