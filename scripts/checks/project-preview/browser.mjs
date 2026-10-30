// Browser Testing only; --run and private stdin are required. Preparation never
// invokes this driver. No transcript, cookie, console or response body is saved.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createBudget, ORIGIN, parseScope, permitted } from "./policy.mjs";

assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "browser");
assert.deepEqual(process.argv.slice(2), ["--run"]);
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 16384) throw new Error("private_input_rejected");
}
const input = JSON.parse(raw);
raw = "";
assert.deepEqual(Object.keys(input).sort(), ["auth", "scope"]);
const scope = parseScope(input.scope),
  auth = input.auth;
assert.deepEqual(Object.keys(auth).sort(), ["email", "password", "previewBearer"]);
assert(
  typeof auth.email === "string" &&
    auth.email.length <= 254 &&
    typeof auth.password === "string" &&
    auth.password.length <= 2048 &&
    /^[a-f0-9]{64}$/.test(auth.previewBearer),
);
const budget = createBudget(scope),
  checks = {},
  requests = {},
  blockedRequests = [],
  pending = {
    conversation: "requires_real_registered_pilot",
    reconnect: "requires_real_registered_pilot",
    terminal: "requires_real_registered_pilot",
    nativePrompt: "not_authorized_in_phase_A",
  };
let browser,
  context,
  timer,
  page,
  stage = "launch",
  failed = false,
  opened = false,
  discovery = false,
  cleanupAttempted = false,
  cleanupSucceeded = false,
  webSocketsBlocked = 0,
  pageErrors = 0;
function check(value) {
  if (!value) throw new Error("check_failed");
}
function category(url) {
  const p = new URL(url).pathname;
  return p === "/api/projects"
    ? "repositories"
    : p === "/api/projects/open"
      ? "open"
      : p.startsWith("/_next/static/")
        ? "asset"
        : p.startsWith("/api/discovery/")
          ? "discovery"
          : p.startsWith("/api/auth/")
            ? "auth"
            : p === "/__hive-preview/access"
              ? "bootstrap"
              : "page";
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
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--disable-features=MediaRouter",
    ],
  });
  timer = setTimeout(() => {
    failed = true;
    void browser.close();
  }, budget.remaining());
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
  });
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(20000);
  await context.routeWebSocket("**/*", (ws) => {
    webSocketsBlocked++;
    failed = true;
    ws.close();
  });
  await context.addInitScript(() => {
    window.open = () => null;
  });
  context.on("page", (p) => {
    if (page) {
      failed = true;
      void p.close();
    } else page = p;
  });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = req.url(),
      method = req.method(),
      headers = req.headers(),
      body = req.postData() ?? "";
    if (!budget.reserve(url, method, headers, body)) {
      if (blockedRequests.length < 16) {
        const parsed = new URL(url);
        blockedRequests.push({
          sameOrigin: parsed.origin === ORIGIN,
          path: parsed.origin === ORIGIN ? parsed.pathname.slice(0, 160) : "foreign_origin",
          method,
          nextAction: new Headers(headers).has("Next-Action"),
          hasQuery: !!parsed.search,
        });
      }
      failed = true;
      await route.abort("blockedbyclient");
      return;
    }
    const key = category(url);
    requests[key] = (requests[key] ?? 0) + 1;
    try {
      if (method === "POST" && new URL(url).pathname === "/api/auth/login") {
        const value = JSON.parse(body);
        check(value.email === auth.email && value.password === auth.password);
        checks.credentialsOnlyFixedHostLogin = true;
      }
      const res = await route.fetch({
        maxRedirects: 0,
        maxRetries: 0,
        timeout: Math.max(1, Math.min(10000, budget.remaining())),
      });
      const rh = res.headers();
      if (rh["content-disposition"]?.toLowerCase().includes("attachment"))
        throw new Error("download");
      if (
        res.status() >= 300 &&
        res.status() < 400 &&
        rh.location &&
        !permitted(scope, new URL(rh.location, url).href, "GET")
      )
        throw new Error("redirect");
      if (key === "repositories" && res.status() === 200) {
        const bytes = await res.body();
        check(bytes.length <= 1048576);
        const value = JSON.parse(bytes.toString());
        check(
          value.providerAccountId === scope.providerAccountId &&
            value.perPage === 100 &&
            value.provider === "github" &&
            Array.isArray(value.repositories),
        );
        const repo = value.repositories.find((r) => r.providerRepositoryId === scope.repositoryId);
        if (repo) {
          check(repo.fullName === "kethalia/hive" && repo.permissions?.pull === true);
          discovery = true;
        }
      }
      if (key === "open" && res.status() === 200) {
        const bytes = await res.body();
        check(bytes.length <= 65536);
        const value = JSON.parse(bytes.toString());
        check(
          value.workspaceId === scope.workspaceId &&
            value.providerAccountId === scope.providerAccountId &&
            value.repository?.providerRepositoryId === scope.repositoryId &&
            value.repository?.fullName === "kethalia/hive" &&
            value.phase === "awaitingTask" &&
            value.currentTaskId === null &&
            value.nativeThreadId === null &&
            value.terminalSessionName === null,
        );
        opened = true;
      }
      await route.fulfill({ response: res });
      await res.dispose();
    } catch {
      failed = true;
      await route.abort().catch(() => {});
    }
  });
  stage = "bootstrap";
  check(
    budget.reserve(`${ORIGIN}/__hive-preview/access`, "POST", {
      Authorization: `Bearer ${auth.previewBearer}`,
    }),
  );
  const bootstrap = await context.request.post(`${ORIGIN}/__hive-preview/access`, {
    headers: { Authorization: `Bearer ${auth.previewBearer}`, Origin: ORIGIN },
    maxRedirects: 0,
    maxRetries: 0,
    timeout: 10000,
  });
  check(bootstrap.status() === 204);
  await bootstrap.dispose();
  auth.previewBearer = "";
  stage = "login";
  page = await context.newPage();
  page.on("download", (download) => {
    failed = true;
    void download.cancel();
  });
  page.on("pageerror", () => {
    pageErrors++;
    failed = true;
  });
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").waitFor();
  check((await page.locator("input").count()) === 2);
  check((await page.locator('input[type="url"]').count()) === 0);
  await page.waitForFunction(
    () => {
      const form = document.querySelector("form");
      return (
        !!form &&
        Object.keys(form)
          .filter((k) => k.startsWith("__reactProps$"))
          .some((k) => typeof form[k]?.onSubmit === "function")
      );
    },
    null,
    { timeout: 8000 },
  );
  await page.locator("#email").fill(auth.email);
  await page.locator("#password").fill(auth.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("[data-dashboard-main]").waitFor();
  auth.email = "";
  auth.password = "";
  checks.loggedInViaUI = true;
  const cookies = await context.cookies(ORIGIN);
  check(
    cookies.some(
      (c) =>
        c.name === "__Host-hive-session" &&
        c.secure &&
        c.httpOnly &&
        c.path === "/" &&
        c.sameSite === "Lax" &&
        c.domain === new URL(ORIGIN).hostname,
    ),
  );
  checks.secureCookie = true;
  stage = "deployedBuild";
  check(budget.reserve(`${ORIGIN}/api/app-version`, "GET"));
  const version = await context.request.get(`${ORIGIN}/api/app-version`, {
    maxRedirects: 0,
    maxRetries: 0,
    timeout: Math.min(10000, budget.remaining()),
  });
  check(version.status() === 200);
  const v = await version.json();
  checks.appVersionMatches = v.version === scope.expectedAppVersion;
  checks.appBuildMatches = v.buildId === scope.expectedAppBuild;
  check(v.version === scope.expectedAppVersion && v.buildId === scope.expectedAppBuild);
  await version.dispose();
  checks.reviewedBuild = true;
  stage = "discovery";
  const firstRepositoryPage = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/projects" && r.status() === 200,
  );
  await page.goto(`${ORIGIN}/workspaces?panel=projects&workspace=${scope.workspaceId}`, {
    waitUntil: "domcontentloaded",
  });
  const region = page.getByRole("region", { name: "GitHub projects", exact: true });
  await region.waitFor();
  await firstRepositoryPage;
  const search = region.getByLabel("Search loaded repositories", { exact: true });
  // Pagination is UI-only and shares the four-read ceiling with refresh/polling.
  for (let pageNumber = 1; !discovery && pageNumber < 4; pageNumber++) {
    const next = region.getByRole("button", { name: "Load more repositories", exact: true });
    if (!(await next.isVisible().catch(() => false))) break;
    const nextPage = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/projects" && r.status() === 200,
    );
    await next.click();
    await nextPage;
    await page.waitForTimeout(300);
  }
  await search.fill("hive-browser-acceptance-no-match-00000000");
  await region.getByText("No loaded repositories match this search.", { exact: true }).waitFor();
  await search.fill("kethalia/hive");
  const repository = region.getByRole("button", { name: "kethalia/hive", exact: true });
  await repository.waitFor();
  check(discovery);
  checks.discoveredExpectedRepository = true;
  checks.searchMatchesAndMisses = true;
  stage = "open";
  await repository.click();
  const project = page.getByRole("region", { name: "Project kethalia/hive", exact: true });
  await project.waitFor();
  await project
    .getByText("Project opened. Starting tasks is currently unavailable.", { exact: true })
    .waitFor();
  check(opened);
  check((await project.getByRole("button", { name: "Start task", exact: true }).count()) === 0);
  check(
    (await project.getByRole("textbox", { name: "What do you need?", exact: true }).count()) === 0,
  );
  checks.taskNullProjectOpenedViaUI = true;
  checks.taskControlsUnavailable = true;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  }
  checks.responsiveWithoutHorizontalOverflow = true;
  check(!failed);
  stage = "complete";
} catch {
  failed = true;
} finally {
  if (context && budget.snapshot().loginPosts) {
    cleanupAttempted = true;
    if (budget.reserveCleanup())
      try {
        const res = await context.request.post(`${ORIGIN}/api/auth/logout`, {
          headers: { Origin: ORIGIN },
          maxRedirects: 0,
          maxRetries: 0,
          timeout: Math.max(1, Math.min(5000, budget.remaining())),
        });
        cleanupSucceeded = res.status() === 200;
        await res.dispose();
      } catch {}
  }
  clearTimeout(timer);
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
console.log(
  JSON.stringify({
    schemaVersion: 1,
    phase: "A",
    passed: !failed && stage === "complete" && cleanupSucceeded,
    stage,
    sourceRevision: scope.sourceRevision,
    preflightDigest: scope.preflightDigest,
    checks,
    pending,
    budget: budget.snapshot(),
    requests,
    blockedRequests,
    webSocketsBlocked,
    pageErrors,
    cleanupAttempted,
    cleanupSucceeded,
    browser: browser?.version(),
    screenshots: false,
    traces: false,
    consoleCaptured: false,
    projectTasksStarted: false,
    nativePromptSent: false,
    hostSessionIdentityProven: false,
    coderKeyRetainedForRotation: true,
    outerPreviewHttpBudgetOnly: true,
    backendProviderFanoutMeasured: false,
  }),
);
if (failed || !cleanupSucceeded) process.exitCode = 1;
