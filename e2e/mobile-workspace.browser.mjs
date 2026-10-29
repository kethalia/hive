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
  // Non-terminal windows need the bottom inset normally supplied by the terminal toolbar.
  for (const width of [390, 840]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      const panes = [
        { id: "settings", kind: "hive", tool: "settings", label: "Settings" },
        { id: "files", kind: "app", tool: "files", workspaceId: "software", label: "Files" },
        {
          id: "codex",
          kind: "terminal",
          workspaceId: "software",
          sessionName: "codex",
          label: "codex",
        },
      ];
      localStorage.setItem(
        "general-workspace:v1:fixture",
        JSON.stringify({
          version: 1,
          activeBoardKey: "board-1",
          boards: panes.map((pane, index) => ({
            key: `board-${index + 1}`,
            name: String(index + 1),
            order: index,
            activeWindowId: pane.id,
            windows: [pane],
            manager: {
              mode: "grid",
              columns: [],
              floating: {},
              scroll: 0,
              shortcuts: "primary+alt",
            },
          })),
        }),
      );
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    const workspace = page.getByTestId("general-workspace");
    const settings = page.getByTestId("hive-window-settings");
    await settings.getByText("App updates", { exact: true }).waitFor();
    assert.equal(await workspace.evaluate((el) => getComputedStyle(el).paddingBottom), "8px");
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
    });
    await page.waitForTimeout(200);
    const settingsBox = await settings.boundingBox();
    assert.equal(await workspace.evaluate((el) => getComputedStyle(el).paddingBottom), "34px");
    assert(Math.abs(844 - settingsBox.y - settingsBox.height - 36) < 1);
    const scroller = settings.locator("[data-terminal-frame-content] > div");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    assert(
      await scroller.evaluate(
        (el) => el.scrollTop > 0 && Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= 1,
      ),
    );
    await page.screenshot({ path: resolve(evidence, `settings-bottom-inset-${width}.png`) });
    await page.getByTestId("workspace-board-tab-board-2").click();
    const files = page.getByTestId("general-window-files");
    await page.frameLocator("iframe").getByLabel("File draft").fill("Preserved while resizing");
    await page.waitForTimeout(200);
    const filesBox = await files.boundingBox();
    assert(Math.abs(844 - filesBox.y - filesBox.height - 36) < 1);
    await page.screenshot({ path: resolve(evidence, `app-bottom-inset-${width}.png`) });
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, value: 400 });
      Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 35 });
      visualViewport.dispatchEvent(new Event("resize"));
      visualViewport.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(200);
    const keyboardBox = await files.boundingBox();
    assert.equal(await workspace.evaluate((el) => getComputedStyle(el).paddingBottom), "8px");
    assert(Math.abs(435 - keyboardBox.y - keyboardBox.height - 10) < 1);
    assert.equal(
      await page.frameLocator("iframe").getByLabel("File draft").inputValue(),
      "Preserved while resizing",
    );
    await page.getByTestId("workspace-board-tab-board-3").click();
    const controls = page.getByRole("region", { name: "Terminal mobile controls" });
    await controls.waitFor();
    assert.equal(await workspace.evaluate((el) => getComputedStyle(el).paddingBottom), "0px");
    assert.equal(await controls.evaluate((el) => getComputedStyle(el).paddingBottom), "4px");
    await page.evaluate(() => {
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(200);
    assert.equal(await controls.evaluate((el) => getComputedStyle(el).paddingBottom), "34px");
    await page.getByTestId("workspace-board-tab-board-1").click();
    assert.equal(await workspace.evaluate((el) => getComputedStyle(el).paddingBottom), "34px");
    report.measurements.push({ width, settingsBox, filesBox, keyboardBox });
    report.checks.push(
      `${width}px: Settings and app panes clear the bottom safe area, Settings reaches its scroll end, keyboard spacing contracts, and terminal controls do not double the inset`,
    );
    await context.close();
  }
  // Clipboard feedback must not reserve a second row or hide behind the keyboard.
  for (const width of [390, 840]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    const controls = page.getByRole("region", { name: "Terminal mobile controls" });
    await controls.waitFor();
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
    });
    const restingControls = await controls.boundingBox();
    assert.equal(await controls.evaluate((el) => getComputedStyle(el).paddingBottom), "34px");
    await page.evaluate((shrinkInnerHeight) => {
      Object.defineProperty(visualViewport, "height", { configurable: true, value: 400 });
      Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 35 });
      if (shrinkInnerHeight)
        Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
      visualViewport.dispatchEvent(new Event("resize"));
      visualViewport.dispatchEvent(new Event("scroll"));
    }, width === 390);
    await page.waitForTimeout(220);
    const keyboardControls = await controls.boundingBox();
    const button = await controls.getByRole("button", { name: "Ctrl", exact: true }).boundingBox();
    assert.equal(await controls.evaluate((el) => getComputedStyle(el).paddingBottom), "4px");
    assert.equal(restingControls.height - keyboardControls.height, 30);
    assert(Math.abs(keyboardControls.y + keyboardControls.height - 435) < 1);
    assert(Math.abs(435 - button.y - button.height - 8) < 1);
    let finishUpload;
    let uploadRequested;
    let failUpload = false;
    await page.route("**/terminal/paste-assets", async (route) => {
      await new Promise((done) => {
        finishUpload = done;
        uploadRequested();
      });
      await route.fulfill({
        status: failUpload ? 500 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          failUpload ? { error: "Fixture upload failed" } : { paths: ["/tmp/image.png"] },
        ),
      });
    });
    const picker = controls.getByLabel("Choose files to upload");
    const upload = { name: "image.png", mimeType: "image/png", buffer: Buffer.from("fixture") };
    const toast = page.locator('[data-sonner-toast]:not([data-removed="true"])');
    let request = new Promise((done) => {
      uploadRequested = done;
    });
    await picker.setInputFiles(upload);
    await request;
    await toast.getByText("Uploading files...", { exact: true }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(await toast.count(), 1);
    await toast.evaluate((el) => {
      el.dataset.fixtureUpload = "original";
    });
    const progressToast = await toast.boundingBox();
    assert(progressToast.y >= 35 && progressToast.y + progressToast.height <= 435);
    assert.equal(await controls.getByText("Uploading files...", { exact: true }).count(), 0);
    assert.deepEqual(await controls.boundingBox(), keyboardControls);
    assert.equal(
      await controls.getByRole("button", { name: "Upload files", exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: resolve(evidence, `upload-keyboard-${width}.png`) });
    finishUpload();
    await toast.getByText("Paste complete", { exact: true }).waitFor();
    assert.equal(await toast.count(), 1);
    assert.equal(await toast.getAttribute("data-fixture-upload"), "original");
    assert.equal(await controls.getByText("Paste complete", { exact: true }).count(), 0);
    assert.deepEqual(await controls.boundingBox(), keyboardControls);
    await page.screenshot({ path: resolve(evidence, `upload-complete-${width}.png`) });
    await toast.waitFor({ state: "detached", timeout: 10_000 });
    failUpload = true;
    request = new Promise((done) => {
      uploadRequested = done;
    });
    await picker.setInputFiles(upload);
    await request;
    await toast.getByText("Uploading files...", { exact: true }).waitFor();
    finishUpload();
    await toast.getByText("File paste failed: Fixture upload failed", { exact: true }).waitFor();
    assert.equal(await toast.count(), 1);
    assert.deepEqual(await controls.boundingBox(), keyboardControls);
    assert.equal(
      await controls.getByRole("button", { name: "Upload files", exact: true }).isEnabled(),
      true,
    );
    await page.evaluate(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(200);
    assert.equal(await controls.evaluate((el) => getComputedStyle(el).paddingBottom), "34px");
    assert.equal((await controls.boundingBox()).height, restingControls.height);
    report.measurements.push({ width, restingControls, keyboardControls, progressToast });
    report.checks.push(
      `${width}px: keyboard toolbar has an 8px button gap, restores the closed-keyboard safe area, and uses one visible toast for upload progress/completion/failure without growing the toolbar`,
    );
    await context.close();
  }
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
    assert(Math.abs(boxes[0].x - 8) < 2);
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
      `${width}px: left-aligned header, destination icon, both layouts, bidirectional native touch navigation, and client continuity`,
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
    assert(plusBox.x + plusBox.width <= width - 7);
    assert(Math.abs((await search.boundingBox()).x - 8) < 2);
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
  for (const button of [
    page.getByRole("button", { name: "Search Hive", exact: true }),
    page.getByRole("button", { name: "Switch to Strip view", exact: true }),
    page.getByTestId("workspace-board-tab-board-1"),
    page.getByRole("button", { name: "Create workspace", exact: true }),
  ]) {
    const box = await button.boundingBox();
    assert.equal(box.width, 40);
    assert.equal(box.height, 40);
  }
  await page.getByRole("button", { name: "Switch to Strip view" }).click();
  await page.getByRole("button", { name: "Switch to Grid view" }).click();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
  });
  await page.getByTestId("general-window-files-title").click();
  assert.equal(
    await page
      .getByTestId("general-workspace")
      .evaluate((el) => getComputedStyle(el).paddingBottom),
    "0px",
  );
  await page.screenshot({ path: resolve(evidence, "desktop.png") });
  report.checks.push(
    "desktop: destination-view toggle switches both ways without mobile bottom padding",
  );
  await context.close();
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
  app.close();
}
