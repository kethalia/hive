// Browser Testing only. Credentials arrive through stdin and remain memory-only.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createBudget, ORIGIN, permitted } from "./policy.mjs";

assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "browser");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8192) throw new Error("input_limit");
}
const auth = JSON.parse(input);
input = "";
assert.deepEqual(Object.keys(auth).sort(), ["email", "password", "previewBearer"]);
assert.ok(
  typeof auth.email === "string" &&
    auth.email.length <= 254 &&
    typeof auth.password === "string" &&
    auth.password.length <= 2048 &&
    /^[a-f0-9]{64}$/i.test(auth.previewBearer),
);
const budget = createBudget();
const result = {
  schemaVersion: 1,
  origin: ORIGIN,
  checks: {},
  screenshots: false,
  traces: false,
  consoleCaptured: false,
  accountInference: false,
  terminalOpened: false,
  projectTasksStarted: false,
  coderKeyRetainedForRotation: true,
};
let browser,
  context,
  timer,
  step = "launch",
  fatal = false,
  firstPage;
function check(condition) {
  if (!condition) throw new Error("check_failed");
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
  result.browser = browser.version();
  timer = setTimeout(() => {
    fatal = true;
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
  await context.routeWebSocket("**/*", (ws) => ws.close());
  await context.addInitScript(() => {
    window.open = () => null;
  });
  context.on("page", (p) => {
    if (firstPage) void p.close();
    else firstPage = p;
  });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = req.url(),
      method = req.method();
    if (req.isNavigationRequest() && req.frame().page() !== firstPage)
      return route.abort("blockedbyclient");
    if (!budget.reserve(url, method)) return route.abort("blockedbyclient");
    if (method === "POST" && new URL(url).pathname === "/api/auth/login") {
      let body;
      try {
        body = JSON.parse(req.postData() ?? "");
      } catch {
        return route.abort();
      }
      if (
        Object.keys(body).sort().join(",") !== "email,password" ||
        body.email !== auth.email ||
        body.password !== auth.password
      )
        return route.abort();
      result.checks.credentialsOnlyLoginBody = true;
    }
    try {
      // Each fetch is one pre-counted exchange. Never follow redirects in the API client.
      const response = await route.fetch({
        maxRedirects: 0,
        timeout: Math.max(1, Math.min(10000, budget.remaining())),
      });
      const headers = response.headers();
      if (headers["content-disposition"]?.toLowerCase().includes("attachment"))
        return route.abort();
      if (
        response.status() >= 300 &&
        response.status() < 400 &&
        headers.location &&
        !permitted(new URL(headers.location, url).href, "GET")
      )
        return route.abort();
      await route.fulfill({ response });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  step = "bootstrap";
  check(budget.reserve(`${ORIGIN}/__hive-preview/access`, "POST"));
  const bootstrap = await context.request.post(`${ORIGIN}/__hive-preview/access`, {
    headers: { Authorization: `Bearer ${auth.previewBearer}`, Origin: ORIGIN },
    maxRedirects: 0,
    timeout: 10000,
  });
  check(bootstrap.status() === 204);
  await bootstrap.dispose();
  auth.previewBearer = "";
  result.checks.previewBootstrap = true;
  const page = await context.newPage();
  page.on("download", (d) => void d.cancel());
  step = "loginForm";
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").waitFor();
  check((await page.locator("input").count()) === 2);
  check((await page.locator('input[type="url"]').count()) === 0);
  result.checks.fixedHostForm = true;
  await page.locator("#email").fill(auth.email);
  await page.locator("#password").fill(auth.password);
  step = "login";
  const loginResponse = page.waitForResponse(
    (r) => r.url() === `${ORIGIN}/api/auth/login` && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  check((await loginResponse).status() === 200);
  await page.waitForURL(`${ORIGIN}/workspaces`);
  await page.locator("[data-dashboard-main]").waitFor();
  result.checks.normalUiLogin = true;
  const cookies = await context.cookies(ORIGIN);
  const session = cookies.find((c) => c.name === "__Host-hive-session");
  const preview = cookies.find((c) => c.name === "__Host-hive-preview");
  check(session && preview);
  result.checks.secureHttpOnlySession = session.secure && session.httpOnly;
  check(result.checks.secureHttpOnlySession);
  result.checks.hostOnlySession =
    session.domain === new URL(ORIGIN).hostname &&
    session.path === "/" &&
    session.sameSite === "Lax";
  check(result.checks.hostOnlySession);
  step = "viewports";
  result.viewports = [];
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    result.viewports.push({ ...viewport, noHorizontalOverflow: !overflow });
    check(!overflow);
  }
  step = "apiLogout";
  const logoutStatus = await page.evaluate(
    async () => (await fetch("/api/auth/logout", { method: "POST" })).status,
  );
  check(logoutStatus === 200);
  result.checks.apiLogout = true;
  result.checks.normalUiLogout = "unverified: preview blocks Settings server action";
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").waitFor();
  result.checks.sessionCookieCleared = !(await context.cookies(ORIGIN)).some((c) =>
    ["__Host-hive-session", "hive-session"].includes(c.name),
  );
  check(result.checks.sessionCookieCleared);
  // Replay only the old Hive session in memory, with preview authorization, against fixed read-only authentication gate.
  step = "logoutInvalidation";
  const target = `${ORIGIN}/api/delivery/tasks`;
  check(budget.reserve(target, "GET"));
  const replay = await context.request.get(target, {
    headers: { Cookie: `${preview.name}=${preview.value}; ${session.name}=${session.value}` },
    maxRedirects: 0,
    timeout: 10000,
  });
  result.checks.oldSessionRejected = replay.status() === 401;
  await replay.dispose();
  check(result.checks.oldSessionRejected);
  result.passed = true;
} catch {
  result.passed = false;
  result.failureStep = step;
  result.deadlineReached = fatal;
} finally {
  clearTimeout(timer);
  auth.password = "";
  auth.email = "";
  auth.previewBearer = "";
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  result.budget = budget.snapshot();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
