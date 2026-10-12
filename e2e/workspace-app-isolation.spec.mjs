import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

let hive, apps, hiveUrl, appUrl, fixtureDir, policy, retired;
let appRequests = [];
let appAuthorizations = 0;

test.use({
  channel: "chrome",
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [
      "--no-sandbox",
      "--no-proxy-server",
      "--use-fake-device-for-media-stream",
      "--host-resolver-rules=MAP *.example.test 127.0.0.1",
    ],
  },
});
test.describe.configure({ mode: "serial" });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Workspace origin isolation is validated with Chrome.",
);

test.beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "hive-origin-fixture-"));
  const assets = process.env.HIVE_ISOLATION_BUNDLE_DIR || join(fixtureDir, "assets");
  if (!process.env.HIVE_ISOLATION_BUNDLE_DIR) {
    const { buildIsolationFixture } = await import(
      "../scripts/build-workspace-isolation-fixture.mjs"
    );
    await buildIsolationFixture(assets);
  }
  policy = await import(pathToFileURL(join(assets, "isolation-policy.mjs")).href);
  retired = await import(pathToFileURL(join(assets, "retired-proxy.mjs")).href);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(fixtureDir, "key.pem"),
      "-out",
      join(fixtureDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=*.example.test",
    ],
    { stdio: "ignore" },
  );
  const tls = {
    key: await readFile(join(fixtureDir, "key.pem")),
    cert: await readFile(join(fixtureDir, "cert.pem")),
  };
  const bundle = await readFile(join(assets, "bundle.js"));
  const styles = await readFile(join(assets, "style.css"));
  apps = createServer(tls, (req, res) => {
    appRequests.push({
      cookie: req.headers.cookie || "",
      coderToken: req.headers["coder-session-token"] || "",
      path: req.url,
    });
    const url = new URL(req.url, appUrl);
    if (url.pathname === "/auth") {
      res.writeHead(302, {
        "Set-Cookie": "coder-app-session=fixture; Path=/; HttpOnly; Secure; SameSite=Lax",
        Location: `/${url.searchParams.get("tool")}`,
      });
      res.end();
      return;
    }
    if (!req.headers.cookie?.includes("coder-app-session=fixture")) {
      res.writeHead(401);
      res.end("Missing app authentication");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>Workspace app</title><style>body{font-family:system-ui;padding:24px;background:#f5f7fa;color:#17212f}button{padding:10px;margin:8px}pre{white-space:pre-wrap}</style><h1>${url.pathname === "/kasmvnc" ? "Desktop connected" : "Files connected"}</h1><p>Authenticated on an isolated workspace app origin.</p><button onclick="probe()">Probe boundary</button><button onclick="document.documentElement.requestFullscreen()">Fullscreen</button><pre id="result"></pre><script>
async function probe() {
 const result = {};
 try { result.parentDOM = parent.document.getElementById('hive-private-marker').textContent; } catch { result.parentDOM = 'blocked'; }
 result.hiveCookieSeen = document.cookie.includes('hive-session');
 try { result.hiveAPI = await (await fetch(${JSON.stringify(`${hiveUrl}/api/private-fixture`)}, { credentials: 'include' })).text(); } catch { result.hiveAPI = 'blocked'; }
 result.microphoneAllowed = (document.permissionsPolicy || document.featurePolicy).allowsFeature('microphone');
 try { const stream = await navigator.mediaDevices.getUserMedia({audio:true}); stream.getTracks().forEach(track => track.stop()); result.microphone = 'captured'; } catch(error) { result.microphone = error.name; }
 document.getElementById('result').textContent = JSON.stringify(result);
}
</script>`);
  });
  apps.listen(0, "127.0.0.1");
  await once(apps, "listening");
  appUrl = `https://apps.example.test:${apps.address().port}`;
  hive = createServer(tls, async (req, res) => {
    if (req.url.startsWith("/api/workspace-proxy/")) {
      const response = retired[req.method]();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === "HEAD" ? undefined : await response.text());
      return;
    }
    if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle);
      return;
    }
    if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(styles);
      return;
    }
    if (req.url === "/api/private-fixture") {
      res.setHeader("Content-Type", "application/json");
      res.end('{"private":"Hive fixture data"}');
      return;
    }
    if (req.url === "/authorize-tool") {
      let body = "";
      for await (const part of req) body += part;
      const { input, scenario } = JSON.parse(body);
      const directUrl =
        scenario === "/unsafe-host"
          ? `https://evil.hive.example.test:${apps.address().port}/${input.tool}`
          : `${appUrl}/${input.tool}`;
      res.setHeader("Content-Type", "application/json");
      try {
        policy.assertWorkspaceAppIsolated(directUrl, "hive.example.test", [".hive.example.test"]);
        appAuthorizations++;
        res.end(
          JSON.stringify({
            data: {
              url: `${appUrl}/auth?tool=${input.tool}&grant=encrypted-fixture-grant`,
              directUrl,
              reloadRequired: false,
            },
          }),
        );
      } catch {
        res.end(JSON.stringify({ serverError: "Workspace app overlaps Hive cookies" }));
      }
      return;
    }
    res.setHeader("Content-Security-Policy", policy.buildContentSecurityPolicy([appUrl]));
    res.setHeader("Permissions-Policy", policy.buildPermissionsPolicy([appUrl]));
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
    );
  });
  hive.listen(0, "127.0.0.1");
  await once(hive, "listening");
  hiveUrl = `https://hive.example.test:${hive.address().port}`;
});

test.beforeEach(async ({ context }) => {
  appRequests = [];
  appAuthorizations = 0;
  await context.addCookies([
    {
      name: "hive-session",
      value: "fixture-hive-session",
      domain: ".hive.example.test",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  await context.grantPermissions(["microphone"], { origin: hiveUrl });
});

test.afterAll(async () => {
  for (const server of [hive, apps]) {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function openTool(page, tool) {
  await page.getByTestId("tool-picker-trigger").click();
  await page.getByTestId(`tool-option-${tool}`).click();
  await expect(page.getByTestId(`tool-option-${tool}`)).toBeHidden();
}

test("isolated File Browser cannot read Hive or capture its microphone", async ({
  page,
  context,
}, testInfo) => {
  await page.goto(hiveUrl);
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  });
  await openTool(page, "filebrowser");
  const frame = page.frameLocator('iframe[title="Filebrowser"]');
  await expect(frame.getByRole("heading", { name: "Files connected" })).toBeVisible();
  await frame.getByRole("button", { name: "Probe boundary" }).click();
  await expect(frame.locator("#result")).toContainText("NotAllowedError");
  const result = JSON.parse(await frame.locator("#result").textContent());
  expect(result).toEqual({
    parentDOM: "blocked",
    hiveCookieSeen: false,
    hiveAPI: "blocked",
    microphoneAllowed: false,
    microphone: "NotAllowedError",
  });
  expect(appRequests.length).toBeGreaterThan(0);
  expect(
    appRequests.every((request) => !request.cookie.includes("hive-session") && !request.coderToken),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("isolated-filebrowser.png"), fullPage: true });
  const popup = await context.newPage();
  await popup.goto(`${appUrl}/filebrowser`);
  expect(
    await popup.evaluate(
      async () => (await navigator.permissions.query({ name: "microphone" })).state,
    ),
  ).toBe("prompt");
  await popup.close();
});

test("desktop tools remain embedded and keep their app authentication", async ({
  page,
}, testInfo) => {
  await page.goto(hiveUrl);
  await openTool(page, "kasmvnc");
  await expect(
    page
      .frameLocator('iframe[title="KasmVNC"]')
      .getByRole("heading", { name: "Desktop connected" }),
  ).toBeVisible();
  const frame = page.locator('iframe[title="KasmVNC"]');
  await openTool(page, "terminal");
  await openTool(page, "kasmvnc");
  expect(appAuthorizations).toBe(1);
  await expect(frame).toBeVisible();
  await page
    .frameLocator('iframe[title="KasmVNC"]')
    .getByRole("button", { name: "Fullscreen", exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await page.screenshot({ path: testInfo.outputPath("isolated-desktop.png"), fullPage: true });
});

test("cookie-overlapping app hosts fail closed before app authentication", async ({ page }) => {
  await page.goto(`${hiveUrl}/unsafe-host`);
  await openTool(page, "filebrowser");
  await expect(page.getByText("Could not open this workspace tool.")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(appAuthorizations).toBe(0);
  expect(appRequests).toHaveLength(0);
});

test("legacy proxy navigation and script resources are inert", async ({ page }) => {
  const legacy = `${hiveUrl}/api/workspace-proxy/aaaaaaaa-1111-2222-3333-444444444444/filebrowser/evil.html`;
  const response = await page.goto(legacy);
  expect(response.status()).toBe(410);
  expect(response.headers()["permissions-policy"]).toContain("microphone=()");
  await page.goto(hiveUrl);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const result = await page.evaluate(
      async ({ url, method }) => {
        const response = await fetch(url, { method });
        return { status: response.status, contentType: response.headers.get("content-type") };
      },
      { url: legacy, method },
    );
    expect(result.status).toBe(410);
    expect(result.contentType).toContain("application/json");
  }
  const loaded = await page.evaluate(
    (src) =>
      new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.append(script);
      }),
    legacy.replace("evil.html", "evil.js"),
  );
  expect(loaded).toBe(false);
  expect(appRequests).toHaveLength(0);
});
