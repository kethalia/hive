import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
let fixture, directory, hive, terminal, auth, wss, hiveUrl, terminalUrl, childUrl;
let revoked = false;
let terminalCookies = [];
const secret = "session-cookie-browser-fixture-only";
const fixtureEnv = [
  "NODE_ENV",
  "COOKIE_SECRET",
  "COOKIE_DOMAIN",
  "AUTH_SERVICE_SECRET",
  "AUTH_SERVICE_URL",
  "NEXT_PUBLIC_TERMINAL_WS_URL",
  "TERMINAL_PUBLIC_ORIGIN",
  "HIVE_PUBLIC_ORIGIN",
];
const originalEnv = Object.fromEntries(fixtureEnv.map((name) => [name, process.env[name]]));
test.use({
  channel: "chrome",
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [
      "--no-sandbox",
      "--no-proxy-server",
      "--host-resolver-rules=MAP *.example.test 127.0.0.1",
    ],
  },
});
test.describe.configure({ mode: "serial" });
test.skip(({ browserName }) => browserName !== "chromium", "Validated with Chrome.");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-cookie-browser-"));
  const assets = process.env.HIVE_COOKIE_BUNDLE_DIR || join(directory, "assets");
  if (!process.env.HIVE_COOKIE_BUNDLE_DIR) {
    const { buildSessionCookieFixture } = await import(
      "../scripts/build-session-cookie-fixture.mjs"
    );
    await buildSessionCookieFixture(assets);
  }
  fixture = require(join(assets, "server.cjs"));
  const browser = await readFile(join(assets, "browser.js"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=*.example.test",
    ],
    { stdio: "ignore" },
  );
  const tls = {
    key: await readFile(join(directory, "key.pem")),
    cert: await readFile(join(directory, "cert.pem")),
  };
  process.env.NODE_ENV = "production";
  process.env.COOKIE_SECRET = secret;
  process.env.COOKIE_DOMAIN = ".hive.example.test";
  process.env.AUTH_SERVICE_SECRET = "c".repeat(64);
  process.env.TERMINAL_PUBLIC_ORIGIN = "";
  auth = httpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${process.env.AUTH_SERVICE_SECRET}` || revoked) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    const id = req.url.split("/")[2];
    res.end(
      JSON.stringify(
        req.url.endsWith("/token")
          ? { token: "fixture-coder-token", coderUrl: "https://coder.example.test" }
          : {
              sessionId: id,
              userId: id,
              username: id,
              coderUserId: id,
              coderUrl: "https://coder.example.test",
              email: "fixture@example.test",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
      ),
    );
  });
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${await listen(auth)}`;
  terminal = createServer(tls, async (req, res) => {
    terminalCookies.push(Boolean(req.headers.cookie?.includes("hive-session")));
    res.setHeader("Access-Control-Allow-Origin", hiveUrl);
    res.setHeader("Access-Control-Allow-Headers", "Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const result = await fixture.authenticateUpgrade(req);
    res.writeHead(result.ok ? 200 : result.value.status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ authenticated: result.ok, user: result.ok ? result.value.username : null }),
    );
  });
  terminalUrl = `https://terminal.example.test:${await listen(terminal)}`;
  process.env.NEXT_PUBLIC_TERMINAL_WS_URL = terminalUrl.replace(/^https:/, "wss:");
  wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      [...protocols].find((value) => value === "hive-terminal-v1" || value === "hive-audio-v1") ||
      false,
  });
  terminal.on("upgrade", async (req, socket, head) => {
    terminalCookies.push(Boolean(req.headers.cookie?.includes("hive-session")));
    const result = await fixture.authenticateUpgrade(req);
    if (!result.ok) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ user: result.value.username, protocol: ws.protocol }));
    });
  });
  hive = createServer(tls, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, `https://${req.headers.host}`);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    if (url.pathname === "/plant") {
      const attacker = fixture.signCookie("attacker", secret);
      res.setHeader("Set-Cookie", [
        `hive-session=${attacker}; Domain=.hive.example.test; Path=/; Secure; HttpOnly`,
        `__Host-hive-session=${attacker}; Domain=.hive.example.test; Path=/; Secure; HttpOnly`,
        `__Host-hive-session=${attacker}; Domain=.hive.example.test; Path=/api; Secure; HttpOnly`,
      ]);
      res.end("Planted legacy cookie; protected replacements must be rejected.");
      return;
    }
    if (url.pathname === "/login-fixture") {
      const headers = new Headers();
      fixture.appendSetSessionCookieHeaders(
        headers,
        fixture.signCookie("victim", secret),
        url.hostname,
      );
      res.setHeader("Set-Cookie", headers.getSetCookie());
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    if (url.pathname === "/api/auth/terminal-ticket") {
      const response = await fixture.runWithRequest(request, () => fixture.issueTicket(request));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    if (url.pathname === "/api/whoami") {
      const session = await fixture.runWithRequest(request, () => fixture.getRequestSession());
      res.writeHead(session ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ user: session?.user.id || null }));
      return;
    }
    if (url.pathname === "/browser.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(browser);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Session isolation</title><style>body{font:18px system-ui;padding:32px;background:#111;color:#eee}pre{white-space:pre-wrap}</style><h1>Host-only session migration</h1><p>Hive account cookies stay on this hostname. Terminal requests use short-lived tickets.</p><pre id="result"></pre><script src="/browser.js"></script>',
    );
  });
  const port = await listen(hive);
  hiveUrl = `https://hive.example.test:${port}`;
  childUrl = `https://untrusted.hive.example.test:${port}`;
  process.env.HIVE_PUBLIC_ORIGIN = hiveUrl;
});
test.beforeEach(() => {
  revoked = false;
  terminalCookies = [];
});
test.afterAll(async () => {
  for (const socket of wss?.clients || []) socket.terminate();
  wss?.close();
  await Promise.all(
    [hive, terminal, auth].filter(Boolean).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
  if (directory) await rm(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("legacy cookies require a fresh login and are cleared on migration", async ({
  page,
  context,
}) => {
  await page.goto(`${childUrl}/plant`);
  await page.goto(hiveUrl);
  expect(await page.evaluate(async () => (await fetch("/api/whoami")).status)).toBe(401);
  await page.goto(`${hiveUrl}/login-fixture`);
  const cookies = await context.cookies();
  const secure = cookies.find((cookie) => cookie.name === "__Host-hive-session");
  expect(secure).toMatchObject({
    domain: "hive.example.test",
    path: "/",
    secure: true,
    httpOnly: true,
  });
  expect(cookies.filter((cookie) => cookie.name === "hive-session")).toHaveLength(0);
  expect(await page.evaluate(async () => (await (await fetch("/api/whoami")).json()).user)).toBe(
    "victim",
  );
});

test("an untrusted child cannot overwrite the protected Hive account cookie", async ({
  page,
  context,
}) => {
  await page.goto(`${hiveUrl}/login-fixture`);
  const before = (await context.cookies()).find((cookie) => cookie.name === "__Host-hive-session");
  await page.goto(childUrl);
  // Browser network delivery is authoritative; cookie-list filters may match
  // subdomains without exposing Chromium's host-only flag.
  expect(await page.evaluate(async () => (await fetch("/api/whoami")).status)).toBe(401);
  await page.goto(`${childUrl}/plant`);
  const after = (await context.cookies()).find((cookie) => cookie.name === "__Host-hive-session");
  expect(after).toEqual(before);
  await page.goto(hiveUrl);
  const identity = await page.evaluate(
    async () => (await (await fetch("/api/whoami")).json()).user,
  );
  expect(identity).toBe("victim");
  await page.locator("#result").evaluate((element) => {
    element.textContent =
      "Parent-domain cookie injection rejected.\nAuthenticated Hive account: victim\nProtected cookie absent from child hostname.";
  });
  await page.screenshot({ path: `test-results/session-cookie-${test.info().project.name}.png` });
});

test("terminal and audio tickets connect without sharing Hive cookies", async ({ page }) => {
  await page.goto(`${hiveUrl}/login-fixture`);
  for (const [path, protocol] of [
    ["/ws?agentId=agent", "hive-terminal-v1"],
    ["/ws/audio?agentId=agent", "hive-audio-v1"],
  ]) {
    const result = await page.evaluate(
      async ({ url, protocol }) => {
        const protocols = await window.HiveTerminalAuth.terminalAuthProtocols(url, protocol);
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(url, protocols);
          ws.onmessage = ({ data }) => {
            resolve(JSON.parse(data));
            ws.close();
          };
          ws.onerror = () => reject(new Error("WebSocket rejected"));
        });
      },
      { url: `${terminalUrl.replace(/^https:/, "wss:")}${path}`, protocol },
    );
    expect(result).toEqual({ user: "victim", protocol });
  }
  const result = await page.evaluate(
    async (url) => (await window.HiveTerminalAuth.fetchTerminal(url)).json(),
    `${terminalUrl}/keepalive/status`,
  );
  expect(result).toEqual({ authenticated: true, user: "victim" });
  expect(terminalCookies.length).toBeGreaterThan(2);
  expect(terminalCookies.every((present) => !present)).toBe(true);
});

test("tickets cannot authorize a different request or survive logout", async ({ page }) => {
  await page.goto(`${hiveUrl}/login-fixture`);
  const url = `${terminalUrl}/session-events?after=1`;
  const ticket = await page.evaluate(
    async (url) =>
      (
        await (
          await fetch("/api/auth/terminal-ticket", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          })
        ).json()
      ).ticket,
    url,
  );
  expect(
    await page.evaluate(
      async ({ url, ticket }) =>
        (await fetch(url, { headers: { Authorization: `Bearer ${ticket}` } })).status,
      { url: `${terminalUrl}/session-events?after=2`, ticket },
    ),
  ).toBe(401);
  revoked = true;
  expect(
    await page.evaluate(
      async ({ url, ticket }) =>
        (await fetch(url, { headers: { Authorization: `Bearer ${ticket}` } })).status,
      { url, ticket },
    ),
  ).toBe(401);
  expect(await page.evaluate(async () => (await fetch("/api/whoami")).status)).toBe(401);
});
