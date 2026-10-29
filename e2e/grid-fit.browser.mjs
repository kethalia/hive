import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

if (process.env.HIVE_WORKSPACE_PROFILE !== "browser") throw new Error("Run in Browser Testing.");
const { chromium } = await import(process.env.HIVE_PLAYWRIGHT_MODULE ?? "@playwright/test");
const directory = resolve(process.argv[2]);
const evidence = resolve(directory, "grid-evidence");
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
await new Promise((done) => server.listen(8831, "127.0.0.1", done));
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = { checks: [], measurements: [], errors: [] };
const storage = "general-workspace:v1:fixture";
async function drag(page, from, to, touch) {
  if (touch) {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id: 0, ...from }],
    });
    for (let step = 1; step <= 12; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            id: 0,
            x: from.x + ((to.x - from.x) * step) / 12,
            y: from.y + ((to.y - from.y) * step) / 12,
          },
        ],
      });
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
  }
  await page.waitForTimeout(220);
}
async function checkFit(page) {
  const dimensions = await page.evaluate(() => {
    const canvas = document.querySelector("[data-window-layout]").getBoundingClientRect();
    const panes = [...document.querySelectorAll("[data-workspace-window-id]")].map((el) => {
      const rect = el.getBoundingClientRect();
      const buttons = [...el.querySelectorAll("[data-window-header] button")].map((button) => {
        const b = button.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label"),
          left: b.left,
          right: b.right,
          bottom: b.bottom,
        };
      });
      return {
        id: el.dataset.workspaceWindowId,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        buttons,
      };
    });
    return {
      canvas: { left: canvas.left, right: canvas.right, top: canvas.top, bottom: canvas.bottom },
      panes,
      pageWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
    };
  });
  assert.equal(dimensions.panes.length, 3);
  assert(dimensions.pageWidth <= dimensions.viewport);
  for (const pane of dimensions.panes) {
    assert(
      pane.left >= dimensions.canvas.left - 1 && pane.right <= dimensions.canvas.right + 1,
      JSON.stringify(dimensions),
    );
    assert(
      pane.top >= dimensions.canvas.top - 1 && pane.bottom <= dimensions.canvas.bottom + 1,
      JSON.stringify(dimensions),
    );
    for (const button of pane.buttons) {
      assert(
        button.left >= pane.left && button.right <= pane.right + 1 && button.bottom <= pane.bottom,
        JSON.stringify({ pane, button }),
      );
    }
  }
  const settings = page.getByTestId("hive-window-settings");
  for (const button of await settings
    .locator("[data-terminal-frame-content] :is(button, a)")
    .all()) {
    const rect = await button.boundingBox(),
      pane = await settings.boundingBox();
    assert(
      rect.x >= pane.x - 1 && rect.x + rect.width <= pane.x + pane.width + 1,
      "Settings actions fit the tile width",
    );
  }
  return dimensions;
}
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 744, height: 1133 },
    { width: 1194, height: 834 },
    { width: 1440, height: 900 },
  ]) {
    const touch = viewport.width < 1400;
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    await context.addInitScript((key) => {
      if (localStorage.getItem(key)) return;
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
              windows: [
                ...["a", "b"].map((id) => ({
                  id,
                  kind: "terminal",
                  workspaceId: "software",
                  sessionName: id,
                  label: `${id} project terminal`,
                })),
                { id: "settings", kind: "hive", tool: "settings", label: "Settings" },
              ],
              layout: {
                type: "split",
                axis: "x",
                ratio: 0.48,
                first: { type: "leaf", id: "a" },
                second: {
                  type: "split",
                  axis: "y",
                  ratio: 0.5,
                  first: { type: "leaf", id: "b" },
                  second: { type: "leaf", id: "settings" },
                },
              },
              manager: {
                mode: "grid",
                columns: [],
                floating: {},
                scroll: 0,
                shortcuts: "primary+alt",
              },
            },
          ],
        }),
      );
    }, storage);
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831/?audio");
    await page.getByLabel("b input").waitFor();
    await page
      .getByTestId("hive-window-settings")
      .getByText("App updates", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Microphone: disconnected" }).first().waitFor();
    await page.waitForTimeout(300);
    const lifetime = await page.evaluate(() => structuredClone(window.fixture));
    report.measurements.push({ viewport, ...(await checkFit(page)) });
    const widthBorder = page.getByRole("separator", { name: "Resize width", exact: true });
    const heightBorder = page.getByRole("separator", { name: "Resize height", exact: true });
    for (const border of [widthBorder, heightBorder]) {
      assert.equal(await border.locator("*").count(), 0, "Resize border has no decorative grip");
      assert.equal(
        await border.evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
    }
    await page.getByLabel("b input").focus();
    const pane = page.locator('[data-workspace-window-id="b"]');
    const before = await pane.boundingBox();
    const vertical = await widthBorder.boundingBox();
    assert(vertical.height > before.height - 2, "Full shared vertical edge is draggable");
    const point = { x: vertical.x + vertical.width / 2, y: vertical.y + vertical.height * 0.75 };
    await drag(page, point, { x: point.x + 35, y: point.y }, touch);
    assert((await pane.boundingBox()).width > before.width + 20);
    const first = page.locator('[data-workspace-window-id="a"]');
    const firstBefore = await first.boundingBox();
    const horizontal = await heightBorder.boundingBox();
    const hpoint = {
      x: horizontal.x + horizontal.width * 0.12,
      y: horizontal.y + horizontal.height / 2,
    };
    await drag(page, hpoint, { x: hpoint.x, y: hpoint.y + 30 }, touch);
    assert((await first.boundingBox()).height > firstBefore.height + 20);
    if (touch) {
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "b input",
      );
    }
    await checkFit(page);
    await page.screenshot({ path: resolve(evidence, `grid-${viewport.width}.png`) });
    report.checks.push(
      `${viewport.width}: all three windows, audio and header controls fit; both borders resize away from their center without grips`,
    );
    const layout = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)).boards[0].layout,
      storage,
    );
    await page.setViewportSize({ width: viewport.width, height: 420 });
    await page.waitForTimeout(250);
    await checkFit(page);
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    await checkFit(page);
    const after = await page.evaluate(() => structuredClone(window.fixture));
    assert.deepEqual(after.mounts, lifetime.mounts);
    assert.deepEqual(after.destroys, lifetime.destroys);
    await page.reload();
    await page.getByLabel("b input").waitFor();
    await page.waitForTimeout(250);
    assert.deepEqual(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).boards[0].layout, storage),
      layout,
    );
    await checkFit(page);
    report.checks.push(
      `${viewport.width}: reduced-height viewport fits every tile without remounting terminals; split sizes survive reload`,
    );
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise((done) => server.close(done));
}
