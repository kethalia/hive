// Build assets in Software, then run the browser checks in Browser Testing:
// node e2e/templates-push-regressions.mjs --build-only /tmp/hive-templates/assets
// node e2e/templates-push-regressions.mjs /tmp/hive-templates/assets /tmp/hive-templates/evidence
import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const buildOnly = process.argv[2] === "--build-only";
const assets = path.resolve(process.argv[buildOnly ? 3 : 2]);
if (buildOnly) {
  const { build } = createRequire(require.resolve("tsx"))("esbuild");
  const postcss = require("postcss");
  const tailwindcss = require("@tailwindcss/postcss");
  await mkdir(assets, { recursive: true });
  const styles = await postcss([tailwindcss()]).process(
    await readFile("src/app/globals.css", "utf8"),
    {
      from: "src/app/globals.css",
    },
  );
  await writeFile(
    path.join(assets, "style.css"),
    styles.css + (await readFile("src/styles/xterm.css", "utf8")),
  );
  await build({
    entryPoints: ["e2e/fixtures/templates-push.tsx"],
    bundle: true,
    outfile: path.join(assets, "bundle.js"),
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  await cp("public/fonts", path.join(assets, "fonts"), { recursive: true });
  process.exit(0);
}

assert.equal(
  process.env.HIVE_WORKSPACE_PROFILE,
  "browser",
  "Run browser validation in Browser Testing",
);
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  ({ chromium } = require("@playwright/test"));
}
const evidence = path.resolve(process.argv[3]);
await mkdir(evidence, { recursive: true });
const names = ["ai-dev-k8s", "browser-testing", "game-dev", "electronics", "infrastructure"];
let pushes = [];
const streams = new Set();
const streamAttempts = new Map();
const server = createServer(async (req, res) => {
  if (req.url === "/api/templates/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        names.map((name) => ({
          name,
          stale: true,
          lastPushed: null,
          activeVersionId: "fixture",
          localHash: "local",
          remoteHash: "remote",
        })),
      ),
    );
  } else if (req.method === "POST") {
    const name = req.url.split("/")[3];
    pushes.push(name);
    res.writeHead(name === "browser-testing" ? 500 : 200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        name === "browser-testing" ? { error: "Fixture push denied" } : { jobId: name },
      ),
    );
  } else if (req.url.endsWith("/stream")) {
    const name = req.url.split("/")[3];
    const attempt = (streamAttempts.get(name) ?? 0) + 1;
    streamAttempts.set(name, attempt);
    if (name === "electronics" && attempt === 1) {
      res.writeHead(503);
      res.end("Temporary queue lookup failure");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    streams.add(res);
    res.on("close", () => streams.delete(res));
    const interrupted = name === "game-dev" && attempt === 1;
    for (let i = 0; i < (interrupted ? 30 : 100); i++)
      res.write(`data: fixture output line ${i}\n\n`);
    if (interrupted) res.end();
  } else if (
    req.url === "/bundle.js" ||
    req.url === "/style.css" ||
    req.url.startsWith("/fonts/")
  ) {
    res.setHeader(
      "Content-Type",
      req.url.endsWith(".js")
        ? "text/javascript"
        : req.url.endsWith(".css")
          ? "text/css"
          : "font/ttf",
    );
    res.end(await readFile(path.join(assets, req.url.slice(1))));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
    );
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = {
  workspace: "creator-direction-upgrade",
  workspaceReused: true,
  livePushes: false,
  views: [],
  errors: [],
};
try {
  for (const [label, width, height, touch] of [
    ["desktop", 1440, 900, false],
    ["tablet", 900, 800, true],
    ["mobile", 390, 844, true],
  ]) {
    pushes = [];
    streamAttempts.clear();
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const all = page.getByRole("button", { name: "Push all", exact: true });
    await all.waitFor();
    await all.click();
    assert.match(await page.getByRole("dialog").innerText(), /Push all 5 templates/);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator('[data-slot="dialog-overlay"]').waitFor({ state: "detached" });
    assert.deepEqual(pushes, []);
    await page.screenshot({ path: path.join(evidence, `${label}-list.png`) });
    const layout = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      descriptions: [...document.querySelectorAll('td[colspan="7"]')].map((cell) => ({
        wraps: getComputedStyle(cell).whiteSpace === "normal",
        columns: cell.colSpan,
      })),
    }));
    assert.ok(layout.scroll <= layout.client, "Page must not overflow horizontally");
    assert.ok(layout.descriptions.every((cell) => cell.wraps && cell.columns === 7));
    await all.click();
    await page.getByRole("button", { name: "Confirm push all", exact: true }).click();
    await page.locator('[data-slot="dialog-overlay"]').waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelectorAll(".xterm").length === 5);
    await page.waitForFunction(() => document.querySelectorAll(".xterm-rows").length === 5);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".xterm-rows")].filter((rows) =>
          rows.textContent.includes("line 99"),
        ).length === 4,
    );
    assert.equal(streamAttempts.get("electronics"), 2);
    assert.equal(streamAttempts.get("game-dev"), 2);
    assert.deepEqual([...pushes].sort(), [...names].sort());
    assert.equal(await all.isDisabled(), true);
    const region = page.getByTestId("templates-scroll-region");
    console.log(label, "panels ready");
    const metrics = await region.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
    }));
    assert.ok(
      metrics.scroll > metrics.client,
      "Multiple panels must overflow the page's scroll region",
    );
    const firstOutput = page.locator(".xterm-screen").first();
    await firstOutput.scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      document.querySelector(".xterm-rows")?.textContent.includes("line 99"),
    );
    const box = await firstOutput.boundingBox();
    const before = await region.evaluate((el) => el.scrollTop);
    if (touch) {
      const cdp = await context.newCDPSession(page);
      const x = box.x + box.width / 2;
      const y = box.y + box.height - 20;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let delta = 10; delta <= 100; delta += 10) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - delta }],
        });
        await page.waitForTimeout(20);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 300);
    }
    await page.waitForFunction(
      (top) =>
        document.querySelector('[data-testid="templates-scroll-region"]').scrollTop > top + 10,
      before,
    );
    if (touch) {
      const cdp = await context.newCDPSession(page);
      for (let n = 0; n < 8; n++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: 6, y: height - 80 }],
        });
        for (let y = height - 110; y >= 100; y -= 50) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: 6, y }],
          });
          await page.waitForTimeout(20);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(150);
      }
      await cdp.detach();
    } else {
      await page.mouse.move(6, height / 2);
      await page.mouse.wheel(0, 10000);
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="templates-scroll-region"]');
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
    });
    const close = page.getByRole("button", { name: "Close terminal", exact: true }).last();
    console.log(
      label,
      "scrolled",
      await region.evaluate((el) => ({
        top: el.scrollTop,
        height: el.clientHeight,
        total: el.scrollHeight,
      })),
    );
    assert.ok(await close.isVisible());
    await page.screenshot({ path: path.join(evidence, `${label}-progress.png`) });
    await close.click();
    assert.equal(await page.locator(".xterm").count(), 4);
    if (touch) {
      // Exercise a downward swipe inside the refresh surface while the page
      // is already scrolled. It must scroll up rather than start a refresh.
      await region.evaluate((el) => {
        el.scrollTop = 400;
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: width / 2, y: 200 }],
      });
      for (let y = 220; y <= 420; y += 20) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: width / 2, y }],
        });
        await page.waitForTimeout(20);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="templates-scroll-region"]').scrollTop < 380,
      );
      assert.equal(
        await page.getByTestId("pull-to-refresh").getAttribute("data-pull-state"),
        "idle",
      );
    }
    report.views.push({
      label,
      layout,
      metrics,
      pushes: [...pushes],
      streamRecovery: {
        initial503: "passed",
        midstreamDisconnect: "passed",
        duplicatePushRequests: 0,
      },
      scrollToLastPanel: "passed",
      scrollOverOutputAtBottom: "passed",
      closeLastPanel: "passed",
      scrollBackUp: touch ? "passed" : "not exercised",
    });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report));
