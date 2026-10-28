import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

if (process.env.HIVE_WORKSPACE_PROFILE !== "browser") throw new Error("Run in Browser Testing.");
const { chromium } = await import(process.env.HIVE_PLAYWRIGHT_MODULE ?? "@playwright/test");
const directory = resolve(process.argv[2] ?? ".artifacts/mobile-workspace/browser");
const evidence = resolve(directory, "controls-evidence");
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
const storage = "general-workspace:v1:fixture";
const boardState = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)).boards[0], storage);
async function seed(context, width, mode = "strip") {
  await context.addInitScript(
    ({ key, width, mode }) => {
      if (localStorage.getItem(key)) return;
      const ids = ["a", "b"];
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          activeBoardKey: "board-1",
          boards: [
            {
              key: "board-1",
              name: "1",
              order: 0,
              activeWindowId: "b",
              windows: ids.map((id) => ({
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
                mode,
                columns: ids.map((id) => ({
                  id,
                  windows: [id],
                  width: 0.5,
                  weights: {},
                  tabbed: false,
                })),
                floating: {},
                scroll: Math.max(0, 560 - width),
                shortcuts: "primary+alt",
              },
            },
          ],
        }),
      );
    },
    { key: storage, width, mode },
  );
}
async function drag(page, from, to, during, cancel = false) {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 0, x: from.x, y: from.y }],
  });
  for (let step = 1; step <= 20; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          id: 0,
          x: from.x + ((to.x - from.x) * step) / 20,
          y: from.y + ((to.y - from.y) * step) / 20,
        },
      ],
    });
    await page.waitForTimeout(20);
  }
  if (during) await during();
  await session.send("Input.dispatchTouchEvent", {
    type: cancel ? "touchCancel" : "touchEnd",
    touchPoints: [],
  });
  await session.detach();
  await page.waitForTimeout(400);
}
try {
  for (const width of [390, 744, 1194]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: true,
      isMobile: true,
    });
    await seed(context, width);
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.goto("http://127.0.0.1:8831");
    await page.getByTestId("terminal-mobile-shell").waitFor();
    await page.getByLabel("b input").waitFor();
    const lifetime = await page.evaluate(() => structuredClone(window.fixture));
    const pane = (id) => page.locator(`[data-workspace-window-id="${id}"]`);
    const before = await pane("b").boundingBox();
    const left = page.getByRole("separator", { name: "Resize width" }).last();
    const handle = await left.boundingBox();
    assert(handle.width >= 44 && handle.x >= 0 && handle.x + handle.width <= width);
    await drag(
      page,
      { x: handle.x + 22, y: handle.y + 22 },
      { x: handle.x + 22 - 70, y: handle.y + 22 },
    );
    const larger = await pane("b").boundingBox();
    assert(
      larger.width > before.width + 50,
      `last pane must grow from left: ${JSON.stringify({ before, larger })}`,
    );
    assert(
      Math.abs(larger.x + larger.width - (before.x + before.width)) < 2,
      "last right edge stays anchored",
    );
    await page.screenshot({ path: resolve(evidence, `last-pane-${width}.png`) });
    report.checks.push(`${width}: grow final Strip pane from left edge`);
    await page.getByRole("button", { name: "Search Hive", exact: true }).tap();
    const list = page.locator("[cmdk-list]");
    await list.waitFor();
    await page.waitForTimeout(250);
    const rect = await list.boundingBox();
    await swipe(page, [[rect.x + rect.width / 2, rect.y + rect.height - 35]], 0, -220);
    assert((await list.evaluate((el) => el.scrollTop)) > 30, "native touch scrolls search results");
    for (let i = 0; i < 5; i++)
      await swipe(page, [[rect.x + rect.width / 2, rect.y + rect.height - 35]], 0, -220);
    assert(
      (await list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)) < 3,
      "can reach final menu option",
    );
    const bottom = await list.evaluate((el) => el.scrollTop);
    await swipe(page, [[rect.x + rect.width / 2, rect.y + 35]], 0, 200);
    assert((await list.evaluate((el) => el.scrollTop)) < bottom - 20, "can scroll back up");
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await page.screenshot({ path: resolve(evidence, `menu-${width}.png`) });
    report.checks.push(`${width}: scroll menu down, reach bottom, scroll back without moving page`);
    await page.waitForTimeout(800); // Let native momentum finish before tapping another control.
    await page.getByRole("button", { name: "Drag to dismiss command palette" }).tap();
    await list.waitFor({ state: "hidden" });
    const title = await page.getByTestId("general-window-b-title").boundingBox();
    const target = await pane("a").boundingBox();
    await drag(
      page,
      { x: title.x + Math.min(15, title.width / 2), y: title.y + title.height / 2 },
      { x: Math.max(30, target.x + target.width / 2), y: target.y + 100 },
      async () => {
        assert.equal(await pane("b").getAttribute("data-workspace-window-dragging"), "true");
        await page.getByTestId("workspace-window-drop-placeholder").waitFor();
      },
    );
    await page.waitForTimeout(400);
    const moved = await boardState(page);
    assert.deepEqual(
      moved.manager.columns.map((c) => c.id),
      ["b", "a"],
      "touch reorders Strip columns",
    );
    assert.equal(moved.activeWindowId, "b");
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.fixture.mounts), lifetime.mounts);
    assert.deepEqual(await page.evaluate(() => window.fixture.destroys), lifetime.destroys);
    await page.screenshot({ path: resolve(evidence, `reordered-${width}.png`) });
    report.checks.push(`${width}: touch title drag reorders Strip and preserves terminal lifetime`);
    await page.getByRole("button", { name: "Switch to Grid view" }).tap();
    await page.waitForTimeout(250);
    const gridBefore = await boardState(page);
    const gridTitle = await page.getByTestId("general-window-b-title").boundingBox();
    const gridTarget = await pane("a").boundingBox();
    await drag(
      page,
      { x: gridTitle.x + 15, y: gridTitle.y + gridTitle.height / 2 },
      { x: gridTarget.x + Math.min(30, gridTarget.width / 2), y: gridTarget.y + 20 },
    );
    const gridAfter = await boardState(page);
    assert.notDeepEqual(gridAfter.layout, gridBefore.layout, "touch reorders Grid panes");
    report.checks.push(`${width}: touch title drag rearranges Grid`);
    await page.getByTestId("general-window-b-title").tap();
    await page.keyboard.press("Control+Alt+t");
    await page.waitForTimeout(250);
    const floatingBefore = await pane("b").boundingBox();
    const floatingTitle = await page.getByTestId("general-window-b-title").boundingBox();
    await drag(
      page,
      { x: floatingTitle.x + 15, y: floatingTitle.y + floatingTitle.height / 2 },
      { x: floatingTitle.x + 45, y: floatingTitle.y + 65 },
    );
    const floatingAfter = await pane("b").boundingBox();
    assert(floatingAfter.y > floatingBefore.y + 20, "touch moves floating pane");
    assert.deepEqual(await page.evaluate(() => window.fixture.mounts), lifetime.mounts);
    assert.deepEqual(await page.evaluate(() => window.fixture.destroys), lifetime.destroys);
    const cancelTitle = await page.getByTestId("general-window-b-title").boundingBox();
    await drag(
      page,
      { x: cancelTitle.x + 15, y: cancelTitle.y + 8 },
      { x: cancelTitle.x + 30, y: cancelTitle.y + 45 },
      undefined,
      true,
    );
    const canceled = await pane("b").boundingBox();
    assert(
      Math.abs(canceled.y - floatingAfter.y) < 2,
      "touch cancellation restores the original position",
    );
    assert.equal(await pane("b").getAttribute("data-workspace-window-dragging"), "false");
    const beforeReload = await boardState(page);
    await page.reload();
    await page.getByLabel("b input").waitFor();
    await page.waitForTimeout(250);
    assert.deepEqual(
      (await boardState(page)).layout,
      beforeReload.layout,
      "Grid order survives reload",
    );
    const restored = await pane("b").boundingBox();
    assert(Math.abs(restored.y - floatingAfter.y) < 2, "floating position survives reload");
    report.checks.push(
      `${width}: touch moves floating pane without remounting; order and position persist`,
    );
    await context.close();
  }
  // Exercise the real xterm DOM and its document touch handlers, not only the lightweight pane fixture.
  const terminalContext = await browser.newContext({
    viewport: { width: 744, height: 1133 },
    hasTouch: true,
    isMobile: true,
  });
  await seed(terminalContext, 744);
  const terminalPage = await terminalContext.newPage();
  terminalPage.on("pageerror", (error) => report.errors.push(error.message));
  await terminalPage.goto("http://127.0.0.1:8831/?xterm");
  await terminalPage.getByTestId("terminal-mobile-shell").waitFor();
  const screen = terminalPage.locator('[data-workspace-window-id="b"] .xterm-screen');
  await screen.waitFor();
  await terminalPage.waitForTimeout(300);
  const surface = await screen.boundingBox();
  const session = await terminalContext.newCDPSession(terminalPage);
  const points = [
    { id: 1, x: surface.x + 70, y: surface.y + 220 },
    { id: 2, x: surface.x + 150, y: surface.y + 220 },
  ];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]] });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...points[0], y: points[0].y - 6 }, points[1]],
  });
  for (let step = 1; step <= 12; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points.map((point, index) => ({
        ...point,
        x: point.x + step * 1.5,
        y: point.y - step * (index ? 5 : 7),
      })),
    });
    await terminalPage.waitForTimeout(20);
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [{ ...points[1], x: points[1].x + 18, y: points[1].y - 60 }],
  });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  const terminalList = terminalPage.locator("[cmdk-list]");
  await terminalList.waitFor();
  await terminalPage.waitForTimeout(500);
  assert(await terminalList.isVisible(), "search stays open after a two-finger terminal gesture");
  const listBox = await terminalList.boundingBox();
  await swipe(
    terminalPage,
    [[listBox.x + listBox.width / 2, listBox.y + listBox.height - 30]],
    0,
    -200,
  );
  assert(
    (await terminalList.evaluate((el) => el.scrollTop)) > 20,
    "menu scrolls with real terminal handlers installed",
  );
  await terminalPage.screenshot({ path: resolve(evidence, "xterm-search.png") });
  report.checks.push("real xterm: staggered two-finger search stays open and its menu scrolls");
  await terminalContext.close();
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise((done) => server.close(done));
  await new Promise((done) => app.close(done));
}
