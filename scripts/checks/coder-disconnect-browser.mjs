// Browser Testing only. One explicit disconnect; credentials arrive only on
// stdin. Never record browser state, screenshots, console text, or network bodies.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ORIGIN = "https://codex-delivery-system-design-hive.b00ste.workers.dev";
const GET_LIMIT = 100;
const POST_PATH = "/api/auth/coder/disconnect";
const DEDICATED_ACCOUNT_SHA256 = "b2f22ce162b69ecee6f9707ebfd2d702e9d089df3e42e9cbe11b8e96e8ecdbcf";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const need = (condition) => {
  if (!condition) throw new Error("check_failed");
};

export function parseDisconnectInput(raw) {
  need(Buffer.byteLength(raw) <= 8192);
  const input = JSON.parse(raw);
  need(input && typeof input === "object" && !Array.isArray(input));
  need(Object.keys(input).sort().join(",") === "budgetReserved,cookie,schemaVersion");
  need(input.schemaVersion === 1 && input.budgetReserved === GET_LIMIT);
  const cookie = input.cookie;
  need(cookie && typeof cookie === "object" && !Array.isArray(cookie));
  need(
    Object.keys(cookie).sort().join(",") === "name,value" && cookie.name === "__Host-hive-session",
  );
  need(typeof cookie.value === "string" && cookie.value.length <= 4096);
  const parts = cookie.value.split(".");
  need(
    parts.length === 3 &&
      UUID.test(parts[0]) &&
      /^\d{1,16}$/.test(parts[1]) &&
      /^[a-f0-9]{64}$/i.test(parts[2]),
  );
  return { name: cookie.name, value: cookie.value };
}

export function newRequestPolicy() {
  return {
    gets: 0,
    posts: 0,
    postAttempts: 0,
    blocked: 0,
    settingsGets: 0,
    armed: false,
    expected: null,
  };
}

/** Pure policy; the browser request is never sent until this returns true. */
export function allowDisconnectRequest(state, { url: rawURL, method, body, contentType }) {
  let url;
  try {
    url = new URL(rawURL);
  } catch {
    state.blocked++;
    return false;
  }
  if (method === "POST") state.postAttempts++;
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) {
    state.blocked++;
    return false;
  }
  if (method === "GET") {
    // OAuth connection/reconnection is a separate primary-only protocol.
    if (url.pathname.startsWith("/api/auth/") || state.gets >= GET_LIMIT) {
      state.blocked++;
      return false;
    }
    state.gets++;
    if (url.pathname === "/api/settings/window") state.settingsGets++;
    return true;
  }
  if (
    method === "POST" &&
    url.pathname === POST_PATH &&
    !url.search &&
    state.armed &&
    state.posts === 0 &&
    state.expected &&
    contentType?.split(";")[0].trim().toLowerCase() === "application/json" &&
    typeof body === "string" &&
    Buffer.byteLength(body) <= 512
  ) {
    try {
      const input = JSON.parse(body);
      if (
        Object.keys(input).sort().join(",") === "credentialId,version" &&
        input.credentialId === state.expected.credentialId &&
        input.version === state.expected.version
      ) {
        state.posts++;
        state.armed = false;
        return true;
      }
    } catch {
      /* Do not print the request or parser error. */
    }
  }
  state.blocked++;
  return false;
}

export function dispatchSyntheticFocus() {
  let visibility = 0,
    focus = 0;
  const onVisibility = () => {
    visibility++;
  };
  const onFocus = () => {
    focus++;
  };
  window.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  try {
    // TanStack Query5.104.5 listens on window.visibilitychange. This is an
    // explicit DOM signal, not proof of a native window/tab focus transition.
    window.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    return {
      visibility: visibility === 1,
      focus: focus === 1,
      documentVisible: document.visibilityState !== "hidden",
    };
  } finally {
    window.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
  }
}

function disconnectResult(value) {
  need(value && typeof value === "object" && !Array.isArray(value));
  need(Object.keys(value).sort().join(",") === "currentConnection,providerRevocation,status");
  need(
    value.status === "disconnected" &&
      ["acknowledged", "unconfirmed"].includes(value.providerRevocation) &&
      ["disconnected", "changed", "unknown"].includes(value.currentConnection),
  );
  return value;
}

async function run() {
  const report = {
    schemaVersion: 1,
    passed: false,
    checks: {},
    getRequests: 0,
    disconnectPostRequests: 0,
    postAttempts: 0,
    blockedRequests: 0,
    blockedWebSockets: 0,
    downloads: 0,
    popups: 0,
    pageErrors: 0,
  };
  const policy = newRequestPolicy();
  let stage = "input",
    browser,
    watchdog;
  try {
    need(process.env.HIVE_WORKSPACE_PROFILE === "browser" && !process.env.CODER_SESSION_TOKEN);
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      need(Buffer.byteLength(raw) <= 8192);
    }
    const cookie = parseDisconnectInput(raw);
    raw = "";
    stage = "pinned-browser";
    const require = createRequire(import.meta.url);
    need(require("playwright/package.json").version === "1.61.1");
    const { chromium } = await import("playwright");
    watchdog = setTimeout(() => {
      report.timedOut = true;
      void browser?.close().catch(() => {});
    }, 150000);
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 896 },
      serviceWorkers: "block",
      acceptDownloads: false,
      userAgent: "Hive-OAuth-Acceptance/1.0",
    });
    context.setDefaultTimeout(15000);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const permitted = allowDisconnectRequest(policy, {
        url: request.url(),
        method: request.method(),
        body: request.postData(),
        contentType: request.headers()["content-type"],
      });
      if (!permitted) return route.abort("blockedbyclient");
      return route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => {
      report.blockedWebSockets++;
      socket.close();
    });
    await context.addCookies([
      {
        name: cookie.name,
        value: cookie.value,
        url: ORIGIN,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    page.on("pageerror", () => {
      report.pageErrors++;
    });
    page.on("download", (download) => {
      report.downloads++;
      void download.cancel().catch(() => {});
    });
    page.on("popup", (popup) => {
      report.popups++;
      void popup.close().catch(() => {});
    });
    stage = "settings-deep-link";
    // Source: hiveWindowHref({tool:"settings"}) and GeneralWorkspace panel parser.
    const dtoResponse = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === ORIGIN &&
          url.pathname === "/api/settings/window" &&
          response.request().method() === "GET"
        );
      },
      { timeout: 30000 },
    );
    void dtoResponse.catch(() => {});
    const loaded = await page.goto(`${ORIGIN}/workspaces?panel=settings`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    need(
      loaded?.status() === 200 &&
        new URL(page.url()).origin === ORIGIN &&
        new URL(page.url()).pathname === "/workspaces",
    );
    const settings = await dtoResponse;
    need(settings.status() === 200);
    const dtoBytes = await settings.body();
    need(dtoBytes.length <= 65536);
    const dto = JSON.parse(dtoBytes.toString("utf8"));
    need(
      typeof dto.email === "string" &&
        createHash("sha256").update(dto.email).digest("hex") === DEDICATED_ACCOUNT_SHA256,
    );
    const connection = dto.coderConnection;
    need(
      connection &&
        connection.source === "oauth" &&
        connection.status === "connected" &&
        UUID.test(connection.credentialId) &&
        Number.isSafeInteger(connection.version) &&
        connection.version > 0,
    );
    policy.expected = { credentialId: connection.credentialId, version: connection.version };
    const frame = page.locator('[data-pane-label="Settings"]:visible');
    need((await frame.count()) === 1);
    await frame
      .getByRole("button", { name: "Disconnect Coder", exact: true })
      .waitFor({ state: "visible" });
    report.checks.sourceSupportedSettingsWindow = true;
    report.checks.connectedOAuthActionVisible = true;
    report.checks.dedicatedAccountOnly = true;

    stage = "cancel-confirmation";
    await frame.getByRole("button", { name: "Disconnect Coder", exact: true }).click();
    const confirmation = frame.getByRole("group", {
      name: "Confirm Coder disconnect",
      exact: true,
    });
    await confirmation.waitFor({ state: "visible" });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirmation.waitFor({ state: "detached" });
    need(policy.posts === 0 && policy.postAttempts === 0);
    report.checks.cancelSentNoMutation = true;

    stage = "supported-mobile-layout";
    // Source: useIsMobile <=1024 and GeneralWorkspace's MobileTerminalShell.
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileButton = frame.getByRole("button", { name: "Disconnect Coder", exact: true });
    await mobileButton.waitFor({ state: "visible" });
    await mobileButton.scrollIntoViewIfNeeded();
    const box = await mobileButton.boundingBox();
    need(
      box && box.x >= -1 && box.y >= -1 && box.x + box.width <= 391 && box.y + box.height <= 845,
    );
    report.checks.supportedMobileControlFits = true;
    await page.setViewportSize({ width: 1280, height: 896 });
    await frame
      .getByRole("button", { name: "Disconnect Coder", exact: true })
      .waitFor({ state: "visible" });

    stage = "one-confirmed-disconnect";
    await frame.getByRole("button", { name: "Disconnect Coder", exact: true }).click();
    await confirmation.waitFor({ state: "visible" });
    const reply = page.waitForResponse(
      (response) =>
        response.url() === `${ORIGIN}${POST_PATH}` && response.request().method() === "POST",
      { timeout: 25000 },
    );
    void reply.catch(() => {});
    policy.armed = true;
    await confirmation.getByRole("button", { name: "Confirm disconnect", exact: true }).click();
    const response = await reply;
    report.disconnectHTTPStatus = response.status();
    need(response.status() === 200);
    const resultBytes = await response.body();
    need(resultBytes.length <= 2048);
    const result = disconnectResult(JSON.parse(resultBytes.toString("utf8")));
    report.providerRevocationStatus = result.providerRevocation;
    report.currentConnectionStatus = result.currentConnection;
    need(policy.posts === 1 && policy.postAttempts === 1);
    await frame
      .getByText("This Coder connection was disconnected.", { exact: true })
      .waitFor({ state: "visible" });
    await frame
      .getByText(
        result.providerRevocation === "acknowledged"
          ? "Coder accepted its revocation request."
          : "Coder revocation could not be confirmed.",
        { exact: true },
      )
      .waitFor({ state: "visible" });
    need(
      (await frame
        .getByRole("link", { name: "Continue with Coder", exact: true })
        .getAttribute("href")) === "/api/auth/coder/start",
    );
    report.checks.strictScopedResultShown = true;
    report.checks.accountPayloadNotRetainedInNotice =
      (await frame.getByRole("region", { name: "Account", exact: true }).count()) === 0;
    const savedCookies = await context.cookies(ORIGIN);
    const old = savedCookies.filter((item) => item.name === cookie.name);
    need(old.length === 1 && old[0].value === cookie.value);
    report.checks.originalCookieUnchanged = true;

    stage = "old-cookie-protected-api";
    // Browser fetch goes through the same strict routing budget (not request API).
    const denied = await page.evaluate(async () => {
      const response = await fetch("/api/settings/window", {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json();
      return {
        status: response.status,
        denied: Object.keys(body).length === 1 && body.error === "not_authenticated",
      };
    });
    report.oldCookieAPIStatus = denied.status;
    need(denied.status === 401 && denied.denied);
    report.checks.oldCookieProtectedAPIDenied = true;
    const settingsReadsBeforeFocus = policy.settingsGets;

    stage = "notice-survives-parent-stale-synthetic-focus";
    await page.setViewportSize({ width: 1272, height: 888 });
    await page.waitForTimeout(31050); // Real30s stale interval; DOM focus signal is synthetic.
    const focusSignal = await page.evaluate(dispatchSyntheticFocus);
    need(focusSignal.visibility && focusSignal.focus && focusSignal.documentVisible);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await frame
      .getByText("This Coder connection was disconnected.", { exact: true })
      .waitFor({ state: "visible" });
    need(policy.settingsGets === settingsReadsBeforeFocus);
    report.checks.noticeSurvivedResizeStaleTimeSyntheticFocusAnd401 = true;
    report.checks.noObsoleteSettingsRefetch = true;
    report.checks.syntheticDOMFocusSignalDelivered = true;
    report.checks.documentVisibleForFocusSignal = focusSignal.documentVisible;
    report.checks.nativeTabFocusProven = false;
    report.checks.singleAllowedMutation = policy.posts === 1 && policy.postAttempts === 1;
    report.checks.noServiceWorkerOrDownloads =
      context.serviceWorkers().length === 0 && report.downloads === 0;
    need(
      report.checks.accountPayloadNotRetainedInNotice &&
        report.checks.noServiceWorkerOrDownloads &&
        report.checks.singleAllowedMutation &&
        report.blockedWebSockets === 0 &&
        report.popups === 0 &&
        !report.timedOut,
    );
    report.passed = true;
    await context.close();
  } catch {
    report.failedStage = stage;
  } finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    report.getRequests = policy.gets;
    report.disconnectPostRequests = policy.posts;
    report.postAttempts = policy.postAttempts;
    report.blockedRequests = policy.blocked;
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--run"))
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, prepared: true, getLimit: GET_LIMIT, disconnectPostLimit: 1 })}\n`,
    );
  else process.exitCode = await run();
}
