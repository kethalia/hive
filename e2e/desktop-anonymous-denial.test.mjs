import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { verifyAnonymousCoderLogin } from "./helpers/coder-anonymous-denial.mjs";

assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "browser", "Run in Browser Testing");
let browser;
let server;
let origin;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/protected") {
      res.writeHead(302, { Location: "/login" }).end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/login") res.end("<button>Sign in with GitHub</button>");
    else if (req.url === "/delayed-public")
      res.end(
        '<script>setTimeout(() => { document.body.innerHTML = "<canvas></canvas>Connected (desktop)"; }, 250)</script>',
      );
    else if (req.url === "/error") res.writeHead(503).end("Service unavailable");
    else res.end("<html><body></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function check(path, coderUrl = origin) {
  const page = await browser.newPage();
  try {
    return await verifyAnonymousCoderLogin(page, {
      appUrl: `${origin}${path}`,
      coderUrl,
      timeout: 1000,
    });
  } finally {
    await page.close();
  }
}

test("accepts a successful redirect to the configured Coder login UI", async () => {
  assert.deepEqual(await check("/protected"), {
    kind: "coder-login",
    origin,
    pathname: "/login",
    status: 200,
  });
});
test("rejects a public desktop that creates its canvas after DOMContentLoaded", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/delayed-public`, { waitUntil: "domcontentloaded" });
    assert.equal(await page.locator("canvas").count(), 0);
    await assert.rejects(
      verifyAnonymousCoderLogin(page, {
        appUrl: `${origin}/delayed-public`,
        coderUrl: origin,
        timeout: 1000,
      }),
    );
    assert.equal(await page.locator("canvas").count(), 1);
    assert.match(await page.locator("body").innerText(), /Connected/);
  } finally {
    await page.close();
  }
});
test("rejects an empty page without explicit denial evidence", async () => {
  await assert.rejects(check("/empty"));
});
test("rejects a login page on an unexpected origin", async () => {
  await assert.rejects(check("/protected", "https://unexpected.example.test"));
});
test("rejects an error response instead of treating it as denied access", async () => {
  await assert.rejects(check("/error"));
});
