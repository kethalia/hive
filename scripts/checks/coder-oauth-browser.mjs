// Run only in the Browser Testing workspace. Input is transient stdin; never
// accept Coder credentials or persist browser storage/traces for this check.
import { chromium } from "playwright";

const origin = "https://codex-delivery-system-design-hive.b00ste.workers.dev";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const report = { schemaVersion: 1, passed: false, checks: {}, hiveRequests: 0, coderRequests: 0 };
let browser;
let stage = "input";
try {
  const value = JSON.parse(input);
  if (value.budgetReserved !== 48 || !Array.isArray(value.cookies) || !value.cookies.length)
    throw Error();
  const cookies = value.cookies.map((cookie) => {
    if (
      !["__Host-hive-session", "hive-session", "hive-coder-host"].includes(cookie.name) ||
      typeof cookie.value !== "string" ||
      !cookie.value ||
      cookie.value.length > 4096
    )
      throw Error();
    return {
      name: cookie.name,
      value: cookie.value,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    };
  });
  stage = "launch";
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
    ],
  });
  const context = async () => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 896 },
      serviceWorkers: "block",
    });
    await ctx.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === origin && request.method() === "GET") {
        if (++report.hiveRequests > value.budgetReserved) return route.abort();
      } else if (url.origin === "https://coder.kethalia.com" && request.method() === "GET") {
        if (++report.coderRequests > 60) return route.abort();
      } else return route.abort();
      return route.continue();
    });
    return ctx;
  };
  stage = "anonymous-login";
  const anonymous = await context(),
    page = await anonymous.newPage();
  const response = await page.goto(`${origin}/login`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  if (response?.status() !== 200) throw Error();
  const button = page.getByRole("link", { name: "Continue with Coder", exact: true });
  await button.waitFor({ state: "visible" });
  if (await page.locator('input[type="password"], input[type="email"]').count()) throw Error();
  report.checks.oauthLinkWithoutCredentialInputs = true;
  await page.screenshot({ path: "coder-oauth-login.png", fullPage: true });
  stage = "coder-navigation";
  await Promise.all([
    page.waitForURL((url) => url.origin === "https://coder.kethalia.com", { timeout: 30000 }),
    button.click(),
  ]);
  await page.waitForLoadState("domcontentloaded");
  const destination = new URL(page.url());
  if (
    destination.origin !== "https://coder.kethalia.com" ||
    !["/login", "/oauth2/authorize"].includes(destination.pathname)
  )
    throw Error();
  report.checks.continueNavigatesToFixedCoderHost = true;
  stage = "authenticated-hive";
  const authenticated = anonymous;
  await authenticated.addCookies(cookies);
  const workspaces = await authenticated.newPage();
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded =
      attempt === 0
        ? await workspaces.goto(`${origin}/workspaces`, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          })
        : await workspaces.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    if (loaded?.status() !== 200 || new URL(workspaces.url()).pathname !== "/workspaces")
      throw Error();
    await workspaces
      .getByRole("heading", { name: "Your workspace", exact: true })
      .waitFor({ state: "visible" });
    if (await workspaces.getByRole("link", { name: "Continue with Coder", exact: true }).count())
      throw Error();
  }
  report.checks.authenticatedWorkspaceAndReload = true;
  report.checks.noCoderCredentialTransferred = true;
  report.checks.readOnlyNetworkBoundary = true;
  report.passed = report.hiveRequests <= value.budgetReserved;
  await authenticated.close();
} catch {
  report.failedStage = stage;
} finally {
  await browser?.close().catch(() => {});
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}
