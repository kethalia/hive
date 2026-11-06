// Actual Chrome and bundled React; synthetic loopback only, no preview requests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { formDiagnostics, installPageDiagnostics } from "./diagnostics.mjs";

assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "browser");
let posts = 0;
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(readFileSync(new URL("./fixture-app.js", import.meta.url)));
  } else if (req.url === "/api/auth/login" && req.method === "POST") {
    posts++;
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      '<div id="root"><form><input id="email" type="email" required value=""><input id="password" type="password" required value=""><button type="submit">Sign in</button></form></div><script type="module" src="/app.js"></script>',
    );
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
  ],
});
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(installPageDiagnostics);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const before = await page.evaluate(formDiagnostics);
  assert.equal(before.reactSubmitHandlerPresent, false);
  await page.locator("#email").fill("fixture@example.test");
  await page.locator("#password").fill("SYNTHETIC_FIXTURE");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(100);
  assert.equal(posts, 0);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const f = document.querySelector("form");
    return Object.keys(f).some(
      (k) => k.startsWith("__reactProps$") && typeof f[k]?.onSubmit === "function",
    );
  });
  await page.locator("#email").fill("fixture@example.test");
  await page.locator("#password").fill("SYNTHETIC_FIXTURE");
  const ready = await page.evaluate(formDiagnostics);
  assert.equal(ready.reactSubmitHandlerPresent, true);
  assert.equal(ready.emailControlledMatches, true);
  assert.equal(ready.passwordControlledMatches, true);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForResponse((r) => r.url() === `${origin}/api/auth/login`).catch(() => {});
  assert.equal(posts, 1);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      previewRequests: 0,
      syntheticOnly: true,
      beforeHydration: before,
      afterHydration: ready,
      preHydrationLoginPosts: 0,
      readyLoginPosts: 1,
      firstLiveFailureCauseProven: false,
    }),
  );
  await context.close();
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
