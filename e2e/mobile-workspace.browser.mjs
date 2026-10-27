import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

if (process.env.HIVE_WORKSPACE_PROFILE !== "browser") throw new Error("Run in Browser Testing.");
const { chromium } = await import(process.env.HIVE_PLAYWRIGHT_MODULE ?? "@playwright/test");
const directory = resolve(process.argv[2] ?? ".artifacts/mobile-workspace/browser");
const evidence = resolve(directory, "mobile-evidence");
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
const current = (page) =>
  page
    .locator('[data-testid^="general-window-"][data-active="true"]')
    .first()
    .getAttribute("data-testid");
try {
  for (const width of [390, 840]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    await page.getByTestId("terminal-mobile-shell").waitFor();
    await page.getByLabel("codex input").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("navigation", { name: "Open windows" }).count(), 0);
    const search = page.getByRole("button", { name: "Search Hive", exact: true });
    const toggle = page.getByRole("button", { name: "Switch to Strip view", exact: true });
    const board = page.getByTestId("workspace-board-tab-board-1");
    const plus = page.getByRole("button", { name: "Create workspace" });
    const boxes = await Promise.all(
      [search, toggle, board, plus].map((locator) => locator.boundingBox()),
    );
    for (let i = 1; i < boxes.length; i++)
      assert(boxes[i].x >= boxes[i - 1].x + boxes[i - 1].width);
    assert(Math.abs(width - boxes[3].x - boxes[3].width - 8) < 2);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const header = await search.evaluate((element) => {
      const style = getComputedStyle(element.closest("header"));
      return { background: style.backgroundColor, backdropFilter: style.backdropFilter };
    });
    assert.equal(header.backdropFilter, "none");
    assert(!header.background.includes("0)"));
    report.measurements.push({ width, header, headerButtons: boxes });
    await page.screenshot({ path: resolve(evidence, `grid-${width}.png`) });
    await page.frameLocator("iframe").getByLabel("File draft").fill("Keep this app draft");
    await page.locator("iframe").evaluate((element) => {
      element.dataset.instance = "original";
    });
    const lifetime = await page.evaluate(() => structuredClone(window.fixture));
    await toggle.click();
    await page.getByRole("button", { name: "Switch to Grid view", exact: true }).waitFor();
    await page.keyboard.press("Control+Alt+1");
    await page.waitForTimeout(200);
    const output = page.getByTestId("general-window-codex").locator("p").first();
    await output.click();
    const box = await output.boundingBox();
    await swipe(page, [[box.x + 180, box.y + 10]], -90, 0);
    assert.equal(await current(page), "general-window-claude");
    assert.equal(await page.getByRole("dialog").count(), 0);
    const claudeOutput = await page
      .getByTestId("general-window-claude")
      .locator("p")
      .first()
      .boundingBox();
    await swipe(page, [[Math.max(20, claudeOutput.x + 25), claudeOutput.y + 10]], 90, 0);
    assert.equal(await current(page), "general-window-codex");
    await page.screenshot({ path: resolve(evidence, `strip-${width}.png`) });
    assert.equal(await page.locator("iframe").getAttribute("data-instance"), "original");
    assert.equal(
      await page.frameLocator("iframe").getByLabel("File draft").inputValue(),
      "Keep this app draft",
    );
    assert.deepEqual(await page.evaluate(() => window.fixture.mounts), lifetime.mounts);
    assert.deepEqual(await page.evaluate(() => window.fixture.destroys), lifetime.destroys);
    report.checks.push(
      `${width}px: right-aligned header, destination icon, both layouts, bidirectional native touch navigation, and client continuity`,
    );
    // The fixture substitutes terminal input with a textarea; gesture over its output surface.
    await output.evaluate((element) => {
      element.style.minHeight = "180px";
    });
    const gestureBox = await output.boundingBox();
    await swipe(
      page,
      [
        [gestureBox.x + 30, gestureBox.y + 120],
        [gestureBox.x + 90, gestureBox.y + 120],
      ],
      0,
      -90,
    );
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    const sheet = page.locator('[data-slot="sheet-content"]');
    const normal = await sheet.boundingBox();
    assert(normal.height > 600 && normal.y < 210);
    const padding = await sheet.evaluate((el) => ({
      left: parseFloat(getComputedStyle(el).paddingLeft),
      right: parseFloat(getComputedStyle(el).paddingRight),
    }));
    assert(padding.left >= 16 && padding.right >= 16);
    await page.screenshot({ path: resolve(evidence, `search-${width}.png`) });
    // Desktop Chrome has no native keyboard. Simulate its VisualViewport resize and panning events.
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, value: 400 });
      Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 35 });
      visualViewport.dispatchEvent(new Event("resize"));
      visualViewport.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(220);
    const raised = await sheet.boundingBox();
    assert(raised.y >= 35 && raised.y < 70);
    assert(Math.abs(raised.y + raised.height - 435) < 2);
    const inputBox = await page.getByRole("combobox").boundingBox();
    assert(inputBox.y >= raised.y && inputBox.y + inputBox.height < 435);
    const list = page.locator("[cmdk-list]");
    const listBox = await list.boundingBox();
    assert(listBox.height > 140 && listBox.y + listBox.height <= 435);
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    assert(await list.evaluate((el) => el.scrollTop > 0));
    await page.screenshot({ path: resolve(evidence, `keyboard-${width}.png`) });
    report.measurements.push({
      width,
      normalSearch: normal,
      keyboardSearch: raised,
      list: listBox,
      padding,
    });
    report.checks.push(
      `${width}px: two-finger upward search, taller padded drawer, keyboard resize/pan lift, scrollable results`,
    );
    await page.getByRole("button", { name: "Drag to dismiss command palette" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.evaluate(() => {
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(220);
    await page.getByRole("button", { name: "Switch to Grid view" }).click();
    await page.keyboard.press("Control+Alt+1");
    await page.waitForTimeout(200);
    const gridOutput = await output.boundingBox();
    await swipe(page, [[gridOutput.x + 180, gridOutput.y + 10]], -90, 0);
    assert.equal(await current(page), "general-window-claude");
    const focused = await page.getByTestId("general-window-claude").boundingBox();
    assert(focused.x >= 0 && focused.x + focused.width <= width);
    report.checks.push(`${width}px: Grid swipe reveals the next window inside the canvas`);
    // Many numbered workspaces scroll within the header; the search/toggle/+ stay reachable.
    for (let i = 0; i < 8; i++) await plus.click();
    await page.waitForTimeout(200);
    const tabs = page.getByTestId("workspace-board-tablist");
    if (width < 600) assert(await tabs.evaluate((el) => el.scrollWidth > el.clientWidth));
    const selected = await tabs.locator('[aria-selected="true"]').boundingBox();
    const tabBounds = await tabs.boundingBox();
    assert(
      selected.x >= tabBounds.x - 1 &&
        selected.x + selected.width <= tabBounds.x + tabBounds.width + 1,
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const plusBox = await plus.boundingBox();
    assert(Math.abs(width - plusBox.x - plusBox.width - 8) < 2);
    await page.screenshot({ path: resolve(evidence, `many-workspaces-${width}.png`) });
    report.checks.push(
      `${width}px: many workspace numbers scroll and reveal the selected workspace without hiding the controls`,
    );
    await context.close();
  }
  // Review regressions: vertical stacks and pinned columns must navigate in visible order.
  for (const scenario of ["stack", "pin-left", "pin-right"]) {
    const width = scenario === "stack" ? 390 : 840;
    const context = await browser.newContext({
      viewport: { width, height: 720 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript((scenario) => {
      const ids = scenario === "stack" ? ["a", "b", "c", "d", "e"] : ["a", "b", "c"];
      const column = (id, windows, pin) => ({
        id,
        windows,
        pin,
        width: 1,
        weights: {},
        tabbed: false,
      });
      const columns =
        scenario === "stack"
          ? [column("stack", ids)]
          : ids.map((id) => column(id, [id], id === "b" ? scenario.slice(4) : undefined));
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
              activeWindowId: scenario === "pin-left" ? "b" : "a",
              windows: ids.map((id) => ({
                id,
                kind: "terminal",
                workspaceId: "software",
                sessionName: id,
                label: id,
              })),
              manager: {
                mode: "strip",
                columns,
                floating: {},
                scroll: 0,
                shortcuts: "primary+alt",
              },
            },
          ],
        }),
      );
    }, scenario);
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    await page.getByTestId("terminal-mobile-shell").waitFor();
    await page.getByLabel("a input").waitFor();
    await page.waitForTimeout(300);
    const lifetime = await page.evaluate(() => structuredClone(window.fixture));
    const order =
      scenario === "stack"
        ? ["a", "b", "c", "d", "e"]
        : scenario === "pin-left"
          ? ["b", "a", "c"]
          : ["a", "c", "b"];
    const swipeFromCurrent = async (direction) => {
      const pane = page.locator('[data-testid^="general-window-"][data-active="true"]').first();
      const box = await pane.locator("p").first().boundingBox();
      await swipe(
        page,
        [[box.x + (direction === "left" ? 180 : 30), box.y + 10]],
        direction === "left" ? -90 : 90,
        0,
      );
    };
    for (const id of order.slice(1)) {
      await swipeFromCurrent("left");
      assert.equal(await current(page), `general-window-${id}`);
      const pane = page.getByTestId(`general-window-${id}`);
      const bounds = await pane.boundingBox();
      const viewport = await page
        .locator('[data-window-layout] > [data-mobile-scroll-allow="true"]')
        .boundingBox();
      assert(
        bounds.y >= viewport.y && bounds.y + bounds.height <= viewport.y + viewport.height + 1,
      );
    }
    const scroller = page.locator('[data-window-layout] > [data-mobile-scroll-allow="true"]');
    const forwardScrollTop = await scroller.evaluate((el) => el.scrollTop);
    if (scenario === "stack") assert(forwardScrollTop > 0);
    await page.screenshot({ path: resolve(evidence, `${scenario}-forward.png`) });
    for (const id of order.slice(0, -1).reverse()) {
      await swipeFromCurrent("right");
      assert.equal(await current(page), `general-window-${id}`);
    }
    assert.equal(await scroller.evaluate((el) => el.scrollTop), 0);
    assert.equal(await scroller.evaluate((el) => el.scrollLeft), 0);
    assert.deepEqual(await page.evaluate(() => window.fixture.mounts), lifetime.mounts);
    assert.deepEqual(await page.evaluate(() => window.fixture.destroys), lifetime.destroys);
    report.measurements.push({ scenario, order, forwardScrollTop });
    report.checks.push(
      `${scenario}: native swipes follow visual order, reveal the selected window, and preserve terminal instances in both directions`,
    );
    await context.close();
  }
  for (const width of [390, 840]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { value: true }),
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    await page.getByTestId("terminal-mobile-shell").waitFor();
    await page.waitForTimeout(200);
    const search = page.getByRole("button", { name: "Search Hive", exact: true });
    assert.equal(Math.round((await search.boundingBox()).y), 24);
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--safe-area-inset-top", "44px"),
    );
    assert.equal(Math.round((await search.boundingBox()).y), 68);
    await page.screenshot({ path: resolve(evidence, `installed-safe-area-${width}.png`) });
    report.checks.push(
      `${width}px: installed-app controls clear the status-bar edge with zero and nonzero safe-area insets`,
    );
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://127.0.0.1:8831");
  await page.getByLabel("codex input").waitFor();
  await page.getByRole("button", { name: "Switch to Strip view" }).click();
  await page.getByRole("button", { name: "Switch to Grid view" }).click();
  await page.screenshot({ path: resolve(evidence, "desktop.png") });
  report.checks.push("desktop: destination-view toggle switches both ways");
  await context.close();
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
  app.close();
}
