import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Use the compiler shipped with our existing tsx tooling and the proxy's ws
// dependency. No fixture code or test endpoints enter the production app.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { WebSocketServer } = createRequire(path.resolve("services/terminal-proxy/package.json"))(
  "ws",
);

let server;
let wss;
let url;
let connections;
let answerHealth;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["e2e/fixtures/terminal-continuity.tsx"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  server = createServer((req, res) => {
    if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].contents);
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><html><body><div id="app"></div><script src="/bundle.js"></script></body></html>',
      );
    }
  });
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    const workspace = new URL(req.url, "http://localhost").searchParams.get("workspace");
    connections.push(workspace);
    socket.send('{"type":"hive:ready"}');
    socket.send(Buffer.from(`history-${workspace}\n`));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "hive:ping") {
        if (answerHealth) socket.send(JSON.stringify({ type: "hive:pong", id: message.id }));
      } else if (message.data) socket.send(Buffer.from(message.data));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => {
  connections = [];
  answerHealth = true;
});
test.afterAll(async () => {
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

test("workspace and app navigation retain live connections, DOM, output, and input isolation", async ({
  page,
}) => {
  await page.goto(url);
  const a = page.getByTestId("terminal-a");
  await expect(a).toHaveAttribute("data-state", "connected");
  const original = await a.elementHandle();
  await page.getByLabel("Input a").fill("saved draft");
  for (let index = 0; index < 5; index++) {
    await page.getByRole("button", { name: "Workspace B" }).click();
    await expect(page.getByTestId("terminal-b")).toHaveAttribute("data-state", "connected");
    await page.getByRole("button", { name: "Git view" }).click();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await page.getByRole("button", { name: "Workspace A" }).click();
    await expect(a).toBeVisible();
  }
  expect(await a.evaluate((node, previous) => node === previous, original)).toBe(true);
  await expect(page.getByLabel("Input a")).toHaveValue("saved draft");
  await page.getByLabel("Input a").press("x");
  await expect(a.locator("pre")).toContainText("history-a\nx");
  expect(connections).toEqual(["a", "b"]);
  await expect(page.getByTestId("terminal-b").locator("pre")).toHaveText("history-b\n");
});

test("foregrounding preserves a healthy socket and recovers a half-open socket", async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.getByTestId("terminal-a")).toHaveAttribute("data-state", "connected");
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect.poll(() => connections.length).toBe(1);
  answerHealth = false;
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect.poll(() => connections.length, { timeout: 15000 }).toBe(2);
  answerHealth = true;
  await expect(page.getByTestId("terminal-a")).toHaveAttribute("data-state", "connected");
});
