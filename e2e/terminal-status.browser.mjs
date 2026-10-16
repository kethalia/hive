// Run only in browser-testing after building the terminal-status fixture.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HIVE_PLAYWRIGHT_MODULE || "playwright-core");
const root = new URL(".", import.meta.url).pathname;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = pathname === "/terminal/status" ? "index.html" : pathname.slice(1);
    if (file.includes("..")) throw new Error("Invalid path");
    response.setHeader(
      "Content-Type",
      file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
    );
    response.end(await readFile(join(root, file)));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const evidence = [];
try {
  for (const scenario of [
    { name: "desktop-empty", width: 1440, height: 900, rows: 1, events: 0 },
    { name: "desktop-events", width: 1280, height: 720, rows: 4, events: 100, highlight: true },
    { name: "mobile", width: 390, height: 844, rows: 1, events: 0, touch: true, banner: true },
    { name: "small-mobile", width: 320, height: 600, rows: 2, events: 100, touch: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      isMobile: Boolean(scenario.touch),
      hasTouch: Boolean(scenario.touch),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const workspaces = Object.fromEntries(
      Array.from({ length: scenario.rows }, (_, i) => [
        `workspace-${i + 1}`,
        {
          status: "not-applicable",
          consecutiveFailures: 0,
          activeConnectionCount: 2,
          lastFailureCategory: "manual-shutdown",
          lastFailureReason: "manual-shutdown",
          lastFailureDetail: "Coder reports manual shutdown; keepalive is not applicable.",
          lastHttpStatus: 409,
          lastHttpStatusText: "Conflict",
          lastAttemptDurationMs: 29,
        },
      ]),
    );
    await page.route("**/keepalive/status", (route) => route.fulfill({ json: { workspaces } }));
    const events = Array.from({ length: scenario.events }, (_, i) => ({
      id: i + 1,
      timestamp: "2026-10-16T19:24:00.000Z",
      workspaceId: "workspace-1",
      connectionId: "fixture-connection",
      sessionName: "dev",
      sessionKind: "terminal",
      level: "info",
      type: "upstream_connected",
      details: {},
    }));
    await page.route("**/session-events?*", (route) =>
      route.fulfill({
        json: {
          version: 1,
          instanceId: "fixture",
          startedAt: "2026-10-16T19:24:00.000Z",
          generatedAt: "2026-10-16T19:24:01.000Z",
          events,
        },
      }),
    );
    await page.goto(
      `${origin}/terminal/status?${scenario.banner ? "banner=1&" : ""}${scenario.highlight ? "workspaceId=workspace-1" : ""}`,
    );
    await page.getByText("workspace-1", { exact: true }).first().waitFor();
    const shell = page.locator("[data-dashboard-page-shell]");
    const before = await shell.evaluate((element) => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
    }));
    assert.ok(
      before.contentHeight > before.height,
      `${scenario.name}: diagnostics content must overflow the page, rather than shrink and clip`,
    );
    if (scenario.touch) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 25, y: 350 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 25, y: 250 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 25, y: 120 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(30, 180);
      await page.mouse.wheel(0, 600);
    }
    await page.waitForFunction(
      () => document.querySelector("[data-dashboard-page-shell]").scrollTop > 0,
    );
    if (!scenario.events && !scenario.touch) {
      await shell.evaluate((element) => {
        element.scrollTop = 0;
      });
      const logBounds = await page
        .getByRole("log", { name: "Terminal session events" })
        .boundingBox();
      assert.ok(logBounds);
      await page.mouse.move(
        logBounds.x + 20,
        Math.min(logBounds.y + logBounds.height / 2, scenario.height - 20),
      );
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(
        () => document.querySelector("[data-dashboard-page-shell]").scrollTop > 0,
      );
    }
    await shell.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const lastLink = page.getByRole("link", { name: "Open terminal", exact: true }).last();
    const visible = await lastLink.evaluate(
      (element) =>
        new Promise((resolve) => {
          const observer = new IntersectionObserver(([entry]) => {
            observer.disconnect();
            resolve(entry.isIntersecting);
          });
          observer.observe(element);
        }),
    );
    assert.equal(visible, true, `${scenario.name}: the final workspace action must be reachable`);
    const eventLog = page.getByRole("log", { name: "Terminal session events" });
    if (scenario.events) {
      const logSize = await eventLog.evaluate((element) => ({
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
      }));
      assert.ok(
        logSize.height > 100 && logSize.contentHeight > logSize.height,
        "Event log retains its own usable scroll region",
      );
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${scenario.name}: no horizontal page overflow`);
    await page.screenshot({ path: join(root, `${scenario.name}-bottom.png`) });
    await shell.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(root, `${scenario.name}-top.png`) });
    assert.deepEqual(errors, []);
    evidence.push({
      ...scenario,
      ...before,
      overflow,
      errors,
      checks: [
        scenario.touch ? "touch scroll" : "wheel scroll",
        "bottom workspace action visible",
        "content not clipped",
        "bounded event log",
      ],
    });
    await context.close();
  }
  await writeFile(join(root, "results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
  server.close();
}
