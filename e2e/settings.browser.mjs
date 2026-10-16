// Run only in browser-testing against the Settings build-preview fixture.
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
    const path = request.url.split("?")[0];
    const file = path === "/settings" ? "index.html" : path.slice(1);
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
  for (const width of [320, 390, 768, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      permissions: ["notifications"],
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let version = { version: "2.21.6", buildId: "fixture-loaded-build" };
    let failed = false;
    await page.route("**/api/app-version", (route) =>
      failed
        ? route.fulfill({ status: 503, body: "Unavailable" })
        : route.fulfill({ json: version }),
    );
    await page.goto(`${origin}/settings`);
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    assert.equal(await page.locator('[data-slot="card"]').count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).count(),
      1,
    );
    const check = page.getByRole("button", { name: "Check for updates", exact: true });
    const update = page.getByRole("button", { name: "Update app", exact: true });
    assert.equal(await update.isDisabled(), true);
    await check.click();
    await page.getByText("You're up to date.", { exact: true }).waitFor();
    version = { version: "2.21.6", buildId: "fixture-rebuilt" };
    await check.click();
    await page.getByText("An app update is available.", { exact: true }).waitFor();
    assert.equal(await update.isEnabled(), true);
    failed = true;
    await update.click();
    await page.getByRole("alert").filter({ hasText: "Could not update Hive" }).waitFor();
    assert.equal(await update.isEnabled(), true);
    failed = false;
    version = { version: "2.21.7", buildId: "fixture-new-release" };
    await check.click();
    await page.getByText("2.21.7", { exact: true }).waitFor();
    await Promise.all([page.waitForEvent("load"), update.click()]);
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await check.click();
    await page.getByText("An app update is available.", { exact: true }).waitFor();
    // The second enable control belongs to Settings; the first is the global prompt.
    await page.getByRole("button", { name: "Enable notifications", exact: true }).nth(1).click();
    await page.getByText("Push connected on this device.", { exact: true }).waitFor();
    await page.getByRole("switch", { name: "Agent ready", exact: true }).click();
    await page.waitForFunction(() => window.savedPreferences?.ready === false);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false, `Horizontal overflow at ${width}px`);
    const sections = await page.locator("section").evaluateAll((elements) =>
      elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
      })),
    );
    assert.ok(sections.every((section) => section.left >= 0 && section.right <= width));
    const scroll = page.locator("div.overflow-y-auto").first();
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(root, `settings-${width}.png`) });
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.screenshot({ path: join(root, `settings-${width}-bottom.png`) });
    assert.deepEqual(errors, []);
    evidence.push({
      width,
      overflow,
      errors,
      checks: [
        "sections without cards",
        "single sidebar toggle",
        "current version",
        "same-version rebuild",
        "new release",
        "update failure and retry",
        "update reload",
        "notification setup",
        "preference save",
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
