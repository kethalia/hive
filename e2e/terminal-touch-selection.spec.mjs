import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const { WebSocketServer } = createRequire(path.resolve("services/terminal-proxy/package.json"))(
  "ws",
);
const exec = promisify(execFile);
let server;
let wss;
let url;
let root;
const sessions = new Map();
test.describe.configure({ mode: "serial" });
test.use({ hasTouch: true });
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hive-selection-"));
  const bundle = await build({
    entryPoints: ["e2e/fixtures/terminal-touch-selection.tsx"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    tsconfig: "tsconfig.json",
  });
  const styles = await readFile("src/styles/xterm.css", "utf8");
  server = createServer(async (req, res) => {
    if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].contents);
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(styles);
    } else if (req.url?.startsWith("/state")) {
      const name = new URL(req.url, "http://localhost").searchParams.get("name") ?? "first";
      const socket = sessions.get(name)?.socket;
      let mode = "",
        buffer = "";
      if (socket) {
        mode = (
          await exec("tmux", [
            "-S",
            socket,
            "display-message",
            "-p",
            "#{pane_in_mode}:#{selection_present}",
          ])
        ).stdout.trim();
        try {
          buffer = (await exec("tmux", ["-S", socket, "show-buffer"])).stdout;
        } catch {
          /* No copy yet. */
        }
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ mode, buffer }));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0}#first,#second{margin:16px;width:300px}button{margin:4px}</style><button id="seed">Seed clipboard</button><div id="first" data-terminal-touch-selection="true"></div><div id="second" data-terminal-touch-selection="true"></div><div id="toaster"></div><script src="/bundle.js"></script>',
      );
    }
  });
  wss = new WebSocketServer({ server });
  let serial = 0;
  wss.on("connection", (ws, req) => {
    const name = new URL(req.url, "http://localhost").searchParams.get("name");
    const socket = path.join(root, `${serial++}.sock`);
    const child = spawn("python3", ["-u", "e2e/helpers/selection-tmux-pty.py", socket], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    sessions.set(name, { socket, child });
    child.stdout.on("data", (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    ws.on("message", (data) => {
      if (child.stdin.writable) child.stdin.write(data);
    });
    ws.on("close", () => child.kill());
    child.on("exit", () => {
      if (ws.readyState === ws.OPEN) ws.close();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  for (const ws of wss.clients) ws.terminate();
  for (const { child } of sessions.values()) child.kill();
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});
test.beforeEach(async ({ page, browserName, context }) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(url);
  await expect(page.locator("#first .xterm-rows")).toContainText("ALPHA beta");
  await expect(page.locator("#second .xterm-rows")).toContainText("ALPHA beta");
  await page.getByRole("button", { name: "Seed clipboard" }).click();
  await expect.poll(() => page.evaluate(() => window.selectionFixture.writes.length)).toBe(1);
  await page.evaluate(() => {
    window.selectionFixture.writes.length = 0;
  });
});
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "failed") return;
  const writes = await page.evaluate(() => window.selectionFixture?.writes).catch(() => undefined);
  console.log("Failed-case clipboard observation:", JSON.stringify(writes));
});

async function point(page, col = 0, row = 0, name = "first") {
  const box = await page.locator(`#${name} .xterm-screen`).boundingBox();
  return { x: box.x + ((col + 0.5) * box.width) / 32, y: box.y + ((row + 0.5) * box.height) / 10 };
}
async function touch(page) {
  const client = await page.context().newCDPSession(page);
  return async (type, point) =>
    client.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: point ? [{ ...point, id: 1 }] : [],
    });
}
async function state(page, name = "first") {
  return (await page.request.get(`${url}/state?name=${name}`)).json();
}

test("desktop drag still copies tmux's selected text automatically", async ({ page }) => {
  const start = await point(page);
  const end = await point(page, 5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.selectionFixture.writes.length)).toBe(1);
  const result = await state(page);
  const writes = await page.evaluate(() => window.selectionFixture.writes);
  expect(writes[0].text).toBe(result.buffer);
  expect(writes[0].text).toBe("ALPHA");
});

for (const multiline of [false, true])
  test(`held touch uses real tmux selection and copies on release (multiline=${multiline})`, async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(
      browserName !== "chromium",
      "CDP provides trusted held touch gestures; physical iOS validation is separate.",
    );
    const send = await touch(page);
    await send("touchStart", await point(page));
    await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
    await send("touchMove", await point(page, 5, multiline ? 1 : 0));
    await expect.poll(async () => (await state(page)).mode).toBe("1:1");
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
    await expect(page.locator("textarea:focus")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("tmux-touch-selection.png") });
    await send("touchEnd");
    await expect.poll(() => page.evaluate(() => window.selectionFixture.writes.length)).toBe(1);
    const result = await state(page);
    const writes = await page.evaluate(() => window.selectionFixture.writes);
    expect(writes[0].text).toBe(result.buffer);
    expect(writes[0].text).toBe(multiline ? "ALPHA beta GAMMA delta\nsecon" : "ALPHA");
    expect(writes[0].activation).toBe(true);
    await expect(page.locator("#first")).not.toHaveAttribute("data-terminal-touch-selecting");
  });

test("unsolicited output cannot overwrite the clipboard, and Copy remains available", async ({
  page,
}) => {
  await page.evaluate(() =>
    window.selectionFixture.terms[0].write(`\x1b]52;c;${btoa("workspace requested text")}\x07`),
  );
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.selectionFixture.writes.map((item) => item.text)))
    .toEqual(["workspace requested text"]);
});

test("cancelled touch releases tmux without automatic copying", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Trusted touch cancellation uses CDP.");
  const send = await touch(page);
  await send("touchStart", await point(page));
  await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
  await send("touchMove", await point(page, 8));
  await send("touchCancel");
  await expect(page.locator("#first")).not.toHaveAttribute("data-terminal-touch-selecting");
  await expect.poll(async () => (await state(page)).mode).toBe("0:");
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
});

test("a response in another pane cannot consume the selection's clipboard write", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Trusted touch selection uses CDP.");
  const send = await touch(page);
  await send("touchStart", await point(page));
  await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
  await send("touchMove", await point(page, 5));
  await page.evaluate(() =>
    window.selectionFixture.terms[1].write(`\x1b]52;c;${btoa("other pane")}\x07`),
  );
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await send("touchEnd");
  await expect
    .poll(() => page.evaluate(() => window.selectionFixture.writes.map((item) => item.text)))
    .toEqual(["ALPHA"]);
});

test("a held drag over a URL selects tmux text rather than opening a link menu", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Trusted held touch uses CDP.");
  const send = await touch(page);
  await send("touchStart", await point(page, 0, 2));
  await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
  await send("touchMove", await point(page, 5, 2));
  // Stay beyond the link menu's hover delay while tmux still owns the drag.
  await page.waitForTimeout(650);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await send("touchEnd");
  await expect
    .poll(() => page.evaluate(() => window.selectionFixture.writes.map((item) => item.text)))
    .toEqual(["https"]);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("a held drag over a delayed file path shows no loading or action menu", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Trusted held touch uses CDP.");
  const send = await touch(page);
  await send("touchStart", await point(page, 0, 3));
  await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
  await send("touchMove", await point(page, 5, 3));
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.waitForTimeout(650);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await send("touchEnd");
  await expect
    .poll(() => page.evaluate(() => window.selectionFixture.writes.map((item) => item.text)))
    .toEqual(["docs/"]);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("denied deferred clipboard access offers a working Copy action", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Trusted held touch uses CDP.");
  await page.evaluate(() => {
    navigator.clipboard.write = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  const send = await touch(page);
  await send("touchStart", await point(page));
  await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
  await send("touchMove", await point(page, 5));
  await send("touchEnd");
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.selectionFixture.writes.map((item) => item.text)))
    .toEqual(["ALPHA"]);
});

test("a short swipe and a stationary hold do not copy or create native selection", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Trusted touch uses CDP.");
  const send = await touch(page);
  await send("touchStart", await point(page, 0, 2));
  await send("touchMove", await point(page, 0, 0));
  await send("touchEnd");
  await expect(page.locator("#first")).not.toHaveAttribute("data-terminal-touch-selecting");
  await send("touchStart", await point(page));
  await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
  await send("touchEnd");
  await expect(page.locator("#first")).not.toHaveAttribute("data-terminal-touch-selecting");
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
});

test("selection preserves an input that was already focused", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Trusted held touch uses CDP.");
  await page.locator("#first textarea").focus();
  const send = await touch(page);
  await send("touchStart", await point(page));
  await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
  await page.locator("#first textarea").evaluate((node) => {
    if (document.activeElement !== node) throw new Error("Selection blurred the input");
  });
  await send("touchMove", await point(page, 5));
  await send("touchEnd");
  await expect
    .poll(() => page.evaluate(() => window.selectionFixture.writes.map((item) => item.text)))
    .toEqual(["ALPHA"]);
  await expect(page.locator("#first textarea")).toBeFocused();
});

test("a scrollbar drag does not grant clipboard access", async ({ page }) => {
  await page.evaluate(() => {
    const element = window.selectionFixture.terms[0].element;
    const chrome = document.createElement("div");
    chrome.id = "scrollbar-chrome";
    chrome.setAttribute("role", "scrollbar");
    chrome.style.cssText =
      "position:absolute;left:285px;top:0;width:15px;height:100px;background:gray;z-index:20";
    element.append(chrome);
  });
  const rect = await page.locator("#scrollbar-chrome").boundingBox();
  await page.mouse.move(rect.x + 5, rect.y + 10);
  await page.mouse.down();
  await page.mouse.move(rect.x + 5, rect.y + 60, { steps: 5 });
  await page.mouse.up();
  await page.evaluate(() =>
    window.selectionFixture.terms[0].write(`\x1b]52;c;${btoa("scrollbar attack")}\x07`),
  );
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
});

test("dragging the helper textarea does not grant clipboard access", async ({ page }) => {
  await page.locator("#first textarea").evaluate((helper) => {
    helper.style.cssText =
      "position:absolute;left:0;top:80px;width:120px;height:20px;opacity:1;z-index:40";
    helper.value = "input text";
  });
  const rect = await page.locator("#first textarea").boundingBox();
  await page.mouse.move(rect.x + 5, rect.y + 10);
  await page.mouse.down();
  await page.mouse.move(rect.x + 80, rect.y + 10, { steps: 5 });
  await page.mouse.up();
  await page.evaluate(() =>
    window.selectionFixture.terms[0].write(`\x1b]52;c;${btoa("helper attack")}\x07`),
  );
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
});

test("a held touch on terminal chrome cannot start a selection grant", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Trusted held touch uses CDP.");
  await page.evaluate(() => {
    const element = window.selectionFixture.terms[0].element;
    const chrome = document.createElement("div");
    chrome.id = "touch-chrome";
    chrome.style.cssText =
      "position:absolute;left:285px;top:0;width:15px;height:100px;background:gray;z-index:20";
    element.append(chrome);
  });
  const rect = await page.locator("#touch-chrome").boundingBox();
  const send = await touch(page);
  await send("touchStart", { x: rect.x + 5, y: rect.y + 10 });
  await page.waitForTimeout(600);
  await expect(page.locator("#first")).not.toHaveAttribute("data-terminal-touch-selecting");
  await send("touchMove", { x: rect.x + 5, y: rect.y + 60 });
  await send("touchEnd");
  await page.evaluate(() =>
    window.selectionFixture.terms[0].write(`\x1b]52;c;${btoa("touch chrome attack")}\x07`),
  );
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
});

test("a drag that changes to Shift selection does not retain clipboard access", async ({
  page,
}) => {
  const start = await point(page);
  const end = await point(page, 5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.evaluate(() =>
    window.selectionFixture.terms[0].write(`\x1b]52;c;${btoa("shift attack")}\x07`),
  );
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
});

for (const kind of ["inert", "parking"])
  test(`leaving and returning to a pane permanently cancels its pending write (${kind})`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Trusted held touch uses CDP.");
    await page.evaluate(() => {
      window.selectionFixture.gate.holdClipboard = true;
    });
    const send = await touch(page);
    await send("touchStart", await point(page));
    await expect(page.locator("#first")).toHaveAttribute("data-terminal-touch-selecting", "true");
    await send("touchMove", await point(page, 5));
    await send("touchEnd");
    await expect
      .poll(() => page.evaluate(() => window.selectionFixture.delayed.length))
      .toBeGreaterThan(0);
    await page.evaluate((kind) => {
      const host = document.getElementById("first");
      if (kind === "inert") {
        host.inert = true;
        host.inert = false;
      } else {
        const parent = host.parentNode;
        const next = host.nextSibling;
        const parking = document.createElement("div");
        parking.inert = true;
        document.body.append(parking);
        parking.append(host);
        parent.insertBefore(host, next);
        parking.remove();
      }
      window.selectionFixture.flushClipboard();
    }, kind);
    await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.selectionFixture.writes)).toEqual([]);
    // The cancelled grant stays cancelled; a fresh explicit action still works.
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.selectionFixture.writes.map((item) => item.text)))
      .toEqual(["ALPHA"]);
  });

test("explicit native fallback preserves text after xterm redraw", async ({ page }) => {
  await page.evaluate(() => {
    const host = document.getElementById("first");
    delete host.dataset.terminalTouchSelection;
    host.dataset.terminalNativeSelection = "true";
    host.dataset.terminalSelectionMode = "true";
    const row = host.querySelector(".xterm-rows").firstElementChild;
    const text = row.firstChild.firstChild;
    window.getSelection().setBaseAndExtent(text, 0, text, 5);
  });
  await expect
    .poll(() => page.evaluate(() => window.selectionFixture.selectedText()))
    .toBe("ALPHA");
  await page.evaluate(() => window.selectionFixture.terms[0].refresh(0, 9));
  await expect.poll(() => page.evaluate(() => window.getSelection().isCollapsed)).toBe(true);
  expect(await page.evaluate(() => window.selectionFixture.selectedText())).toBe("ALPHA");
});
