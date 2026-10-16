// Run only in browser-testing against a build-preview fixture; no vendor push call.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HIVE_PLAYWRIGHT_MODULE || "playwright-core");
const root = new URL(".", import.meta.url).pathname;
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/api/notifications/sources") {
      res.setHeader("Content-Type", "application/json");
      res.end('{"success":true}');
      return;
    }
    const path = req.url.split("?")[0];
    const file = path === "/" || path === "/notifications" ? "index.html" : path.slice(1);
    if (file.includes("..")) {
      res.writeHead(400);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".png")
            ? "image/png"
            : "text/html",
    );
    res.end(await readFile(join(root, file)));
  } catch {
    res.writeHead(404);
    res.end();
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
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport, permissions: ["notifications"] });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByText("Push connected on this device.").waitFor();
    await page.getByRole("button", { name: "Preview question" }).click();
    await page.getByRole("button", { name: "Preview ready" }).click();
    await page.getByRole("switch", { name: "Agent ready" }).click();
    await page.waitForFunction(() => window.savedPreferences?.ready === false);
    await page.getByRole("button", { name: "Connect", exact: true }).first().click();
    await page
      .getByText("Workspace connected. Restart agents and trust the Hive hooks in Codex /hooks.")
      .waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${name} has horizontal overflow`);
    await page.screenshot({ path: join(root, `${name}.png`), fullPage: true });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      let finished;
      self.hiveTestHandlers.push({
        data: {
          json: () => ({
            title: "Hive · Question waiting",
            body: "Codex in ai-dev-01",
            kind: "question",
            tag: "fixture-question",
            url: "/workspaces/fixture/terminal?session=dev",
          }),
        },
        waitUntil: (task) => {
          finished = task;
        },
      });
      await finished;
    });
    const notifications = await worker.evaluate(async () =>
      (await self.registration.getNotifications()).map((item) => ({
        title: item.title,
        data: item.data,
        silent: item.silent,
      })),
    );
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].data.url, "/workspaces/fixture/terminal?session=dev");
    await page.getByText("Codex in ai-dev-01").waitFor();
    assert.deepEqual(errors, []);
    evidence.push({
      name,
      viewport,
      horizontalOverflow: overflow,
      errors,
      notifications,
      checks: [
        "device setup",
        "question and ready audio synthesis",
        "preference save",
        "workspace setup",
        "native service-worker notification",
        "foreground toast",
      ],
    });
    await context.close();
  }
  await writeFile(join(root, "results.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
  server.close();
}
