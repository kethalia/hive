import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

if (process.env.HIVE_WORKSPACE_PROFILE !== "browser") throw new Error("Run in Browser Testing.");
const { chromium } = await import(process.env.HIVE_PLAYWRIGHT_MODULE ?? "@playwright/test");
const directory = resolve(process.argv[2] ?? ".artifacts/mobile-workspace/browser");
const evidence = resolve(directory, "interaction-evidence");
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  const file =
    req.url === "/bundle.js" ? "bundle.js" : req.url === "/style.css" ? "style.css" : "index.html";
  res.setHeader(
    "Content-Type",
    file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html",
  );
  res.end(await readFile(resolve(directory, file)));
});
const app = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<body style="background:#101c14;color:#dcffe3"><h2>Files</h2><textarea aria-label="File draft">Unsent draft</textarea>',
  );
});
await new Promise((done) => server.listen(8831, "127.0.0.1", done));
await new Promise((done) => app.listen(8832, "127.0.0.1", done));
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = { checks: [], measurements: [], errors: [] };
async function swipe(page, points, dx, dy) {
  const session = await page.context().newCDPSession(page);
  const touches = points.map(([x, y], id) => ({ x, y, id, radiusX: 2, radiusY: 2 }));
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touches });
  for (let step = 1; step <= 8; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touches.map((p) => ({
        ...p,
        x: p.x + (dx * step) / 8,
        y: p.y + (dy * step) / 8,
      })),
    });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  await page.waitForTimeout(250);
}
try {
  for (const width of [390, 840]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript((width) => {
      localStorage.setItem(
        "general-workspace:v1:fixture",
        JSON.stringify({
          version: 1,
          activeBoardKey: "board-1",
          boards: [
            {
              key: "board-1",
              name: "1",
              order: 0,
              activeWindowId: "a",
              windows: ["a", "b"].map((id) => ({
                id,
                kind: "terminal",
                workspaceId: "software",
                sessionName: id,
                label: id,
              })),
              layout: {
                type: "split",
                axis: width < 600 ? "x" : "y",
                ratio: 0.5,
                first: { type: "leaf", id: "a" },
                second: { type: "leaf", id: "b" },
              },
              manager: {
                mode: "grid",
                columns: ["a", "b"].map((id) => ({
                  id,
                  windows: [id],
                  width: 0.7,
                  tabbed: false,
                  weights: {},
                })),
                floating: {},
                scroll: 0,
                shortcuts: "primary+alt",
              },
            },
          ],
        }),
      );
    }, width);
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    const pane = page.getByTestId("general-window-a");
    await pane.getByLabel("a input").waitFor();
    await page.waitForTimeout(250);
    const lifetime = await page.evaluate(() => structuredClone(window.fixture));
    const search = page.getByRole("button", { name: "Search Hive", exact: true });
    assert.equal(Math.round((await search.boundingBox()).x), 8);
    const drag = async (handle, dx, dy) => {
      const box = await handle.boundingBox();
      assert.equal(dx ? box.width : box.height, 16);
      assert.equal(await handle.locator("span").count(), 0);
      await swipe(page, [[box.x + box.width / 2, box.y + box.height / 2]], dx, dy);
    };
    const axis = width < 600 ? "height" : "width";
    await pane.getByLabel("a input").focus();
    let before = await pane.boundingBox();
    await drag(
      page.getByRole("separator", { name: `Resize ${axis}`, exact: true }),
      axis === "width" ? 70 : 0,
      axis === "height" ? 70 : 0,
    );
    assert((await pane.boundingBox())[axis] > before[axis] + 40);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "a input",
    );
    assert.equal(await pane.getAttribute("data-active"), "true");
    await page.screenshot({ path: resolve(evidence, `grid-resize-${width}.png`) });
    await page.getByRole("button", { name: "Switch to Strip view" }).click();
    await page.waitForTimeout(200);
    before = await pane.boundingBox();
    await page.getByRole("button", { name: "Cycle width of a", exact: true }).tap();
    await page.waitForTimeout(200);
    assert((await pane.boundingBox()).width > before.width + 1);
    assert.equal(await pane.getAttribute("data-active"), "true");
    await page.screenshot({ path: resolve(evidence, `strip-resize-${width}.png`) });
    await pane.getByTestId("general-window-a-title").click();
    await page.keyboard.press("Control+Alt+t");
    await page.waitForTimeout(200);
    before = await pane.boundingBox();
    await page.getByRole("button", { name: "Cycle width of a", exact: true }).tap();
    await page.waitForTimeout(200);
    assert((await pane.boundingBox()).width > before.width + 1);
    before = await pane.boundingBox();
    await drag(page.getByRole("separator", { name: "Resize floating width", exact: true }), 25, 0);
    assert((await pane.boundingBox()).width > before.width + 15);
    before = await pane.boundingBox();
    await drag(page.getByRole("separator", { name: "Resize floating height", exact: true }), 0, 25);
    assert((await pane.boundingBox()).height > before.height + 10);
    report.checks.push(
      `${width}px: Grid resizing and Strip/floating width presets plus border resizing without switching windows`,
    );

    const shell = page.getByTestId("terminal-mobile-shell");
    const keyboard = () =>
      page.evaluate(() => {
        Object.defineProperty(visualViewport, "height", { configurable: true, value: 400 });
        Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 35 });
        visualViewport.dispatchEvent(new Event("resize"));
      });
    await keyboard();
    await page.waitForTimeout(180);
    assert.equal(Math.round((await shell.boundingBox()).height), 400);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(
      () =>
        document.documentElement.style.getPropertyValue("--app-visual-viewport-height") === "844px",
    );
    assert.equal(Math.round((await shell.boundingBox()).height), 844);
    assert.equal(Math.round((await shell.boundingBox()).y), 0);
    await keyboard();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("pageshow"));
      setTimeout(() => {
        delete visualViewport.height;
        delete visualViewport.offsetTop;
      }, 150);
    });
    await page.waitForFunction(
      () =>
        document.documentElement.style.getPropertyValue("--app-visual-viewport-height") === "844px",
    );
    await page.screenshot({ path: resolve(evidence, `foreground-restored-${width}.png`) });
    await keyboard();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(1100);
    assert.equal(Math.round((await shell.boundingBox()).height), 400);
    await page.evaluate(() => {
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(
      () =>
        document.documentElement.style.getPropertyValue("--app-visual-viewport-height") === "844px",
    );
    report.checks.push(
      `${width}px: foreground restores height/pan with missing and delayed resize events, but keeps a genuinely reduced keyboard viewport`,
    );

    await page.evaluate(() => {
      const scroller = document.createElement("div");
      scroller.dataset.testid = "gesture-scroll";
      scroller.dataset.mobileScrollAllow = "true";
      scroller.style.cssText =
        "position:fixed;z-index:45;left:20px;top:180px;width:300px;height:240px;overflow:auto;background:#132018";
      scroller.innerHTML = '<div style="height:1400px">Scrollable window content</div>';
      document.body.append(scroller);
      scroller.scrollTop = 100;
      scroller.dataset.moves = "0";
      scroller.addEventListener("touchmove", () => {
        scroller.dataset.moves = String(Number(scroller.dataset.moves) + 1);
      });
    });
    const scroll = page.getByTestId("gesture-scroll");
    await swipe(
      page,
      [
        [65, 350],
        [145, 350],
      ],
      0,
      -90,
    );
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    assert.equal(await scroll.evaluate((el) => el.scrollTop), 100);
    assert.equal(await scroll.getAttribute("data-moves"), "0");
    await page.getByRole("button", { name: "Drag to dismiss command palette" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await swipe(page, [[65, 350]], 0, -90);
    assert(await scroll.evaluate((el) => el.scrollTop > 100));
    assert(Number(await scroll.getAttribute("data-moves")) > 0);
    await scroll.evaluate((el) => el.remove());
    assert.deepEqual(await page.evaluate(() => window.fixture.mounts), lifetime.mounts);
    assert.deepEqual(await page.evaluate(() => window.fixture.destroys), lifetime.destroys);
    report.checks.push(
      `${width}px: two-finger search suppresses native and manual scrolling; one-finger scrolling and terminal instances remain intact`,
    );
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(resolve(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  await browser.close();
  server.close();
  app.close();
}
