import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const { chromium } = await import(process.env.HIVE_PLAYWRIGHT_MODULE ?? "@playwright/test");
if (process.env.HIVE_WORKSPACE_PROFILE !== "browser")
  throw new Error("Run browser validation in Browser Testing.");
const directory = resolve(process.argv[2] ?? ".artifacts/window-management/browser");
const evidence = resolve(directory, "evidence");
await mkdir(evidence, { recursive: true });
const app = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><body style="background:#101c14;color:#bddec6;font:16px monospace;padding:24px"><h2>Files</h2><p>kethalia / hive</p><textarea aria-label="File draft">Unsent app draft</textarea>',
  );
});
const server = createServer(async (req, res) => {
  try {
    const file =
      req.url === "/bundle.js"
        ? "bundle.js"
        : req.url === "/style.css"
          ? "style.css"
          : "index.html";
    res.setHeader(
      "Content-Type",
      file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html",
    );
    res.end(await readFile(resolve(directory, file)));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise((done) => app.listen(8832, "127.0.0.1", done));
await new Promise((done) => server.listen(8831, "127.0.0.1", done));
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = { checks: [], errors: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://127.0.0.1:8831");
  await page.getByLabel("codex input").waitFor();
  await page.frameLocator("iframe").getByLabel("File draft").fill("Preserved iframe draft");
  await page.locator("iframe").evaluate((el) => (el.dataset.instance = "original"));
  const initial = await page.evaluate(() => structuredClone(window.fixture));
  const box = (id) => page.locator(`[data-workspace-window-id="${id}"]`).boundingBox();
  await page.screenshot({ path: resolve(evidence, "grid.png") });
  const before = await box("codex");
  const divider = page.getByRole("separator", { name: "Resize width" }).first();
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + handle.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForTimeout(220);
  assert(Math.abs((await box("codex")).width - before.width) > 30);
  report.checks.push("pointer resizing changes geometry");
  await divider.focus();
  const resized = await box("codex");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(220);
  assert((await box("codex")).width < resized.width);
  report.checks.push("keyboard resizing changes geometry");
  const drag = await page.getByTestId("general-window-codex-title").boundingBox();
  const target = await box("files");
  const neighbor = await box("claude");
  await page.mouse.move(drag.x + 20, drag.y + 10);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.getByTestId("workspace-window-drop-placeholder").waitFor();
  await page.waitForTimeout(220);
  assert.notDeepEqual(await box("claude"), neighbor);
  await page.screenshot({ path: resolve(evidence, "drag-preview.png") });
  report.checks.push("drag destination border and live neighbor rearrangement");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(220);
  assert.deepEqual(await box("claude"), neighbor);
  report.checks.push("cancel restores original positions");
  const dropHandle = await page.getByTestId("general-window-codex-title").boundingBox();
  await page.mouse.move(dropHandle.x + 20, dropHandle.y + 10);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.getByTestId("workspace-window-drop-placeholder").waitFor();
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.notDeepEqual(await box("claude"), neighbor);
  assert.equal(await page.getByTestId("workspace-window-drop-placeholder").count(), 0);
  report.checks.push("drop commits the previewed arrangement");
  await page.getByRole("button", { name: "Strip layout", exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByLabel("codex input").focus();
  await page.keyboard.press("Control+Alt+ArrowRight");
  assert.equal(await page.getByTestId("general-window-claude").getAttribute("data-active"), "true");
  report.checks.push("directional focus from terminal");
  await page.keyboard.press("Control+Alt+BracketRight");
  await page.waitForTimeout(200);
  const stackDivider = page.getByRole("separator", { name: "Resize height", exact: true });
  const stackHandle = await stackDivider.boundingBox();
  await page.mouse.move(stackHandle.x + stackHandle.width / 2, stackHandle.y + 4);
  await page.mouse.down();
  await page.mouse.move(stackHandle.x + stackHandle.width / 2, stackHandle.y + 64, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert(Math.abs((await box("codex")).height - (await box("claude")).height) > 30);
  await stackDivider.dblclick();
  await page.waitForTimeout(200);
  assert(Math.abs((await box("codex")).height - (await box("claude")).height) < 1);
  report.checks.push("stack resize and double-click reset keep equal neighbor heights");
  await page.getByLabel("claude input").focus();
  await page.keyboard.press("Control+Alt+Shift+KeyT");
  await page.getByRole("tablist", { name: "Column windows" }).waitFor();
  report.checks.push("stack and tab keyboard controls");
  await page.getByLabel("claude input").focus();
  await page.keyboard.press("Control+Alt+KeyP");
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(evidence, "strip.png") });
  assert.equal(await page.locator("iframe").getAttribute("data-instance"), "original");
  assert.equal(
    await page.frameLocator("iframe").getByLabel("File draft").inputValue(),
    "Preserved iframe draft",
  );
  const continuity = await page.evaluate(() => window.fixture);
  assert.deepEqual(continuity.mounts, initial.mounts);
  assert.deepEqual(continuity.destroys, {});
  assert.equal(continuity.appRequests, 1);
  report.checks.push("mode, stack, tabs and pin preserve iframe and terminal instances");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("hive:terminal-notification-focus", {
        cancelable: true,
        detail: { workspaceId: "software", sessionName: "claude" },
      }),
    ),
  );
  assert.equal(await page.getByTestId("general-window-claude").getAttribute("data-active"), "true");
  await page.getByLabel("claude input").focus();
  await page.keyboard.press("Control+Alt+KeyT");
  await page.waitForTimeout(200);
  const floatingBefore = await box("claude");
  await page.getByRole("separator", { name: "Resize floating width", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  assert((await box("claude")).width > floatingBefore.width);
  await page.getByLabel("claude input").focus();
  await page.keyboard.press("Control+Alt+KeyT");
  report.checks.push("floating width resizes and returns to tiling");
  assert.equal(
    await page.getByRole("button", { name: "Arrange windows and shortcuts" }).count(),
    0,
  );
  await page.keyboard.press("Meta+Shift+Slash");
  await page.getByRole("dialog", { name: "Keyboard Shortcuts" }).waitFor();
  await page.getByText("Focus window left", { exact: true }).waitFor();
  await page.getByLabel("Layout shortcuts").waitFor();
  await page.waitForTimeout(250);
  const helpRect = await page.getByRole("dialog", { name: "Keyboard Shortcuts" }).boundingBox();
  assert(
    await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="dialog"]'),
      {
        x: helpRect.x + helpRect.width / 2,
        y: helpRect.y + 30,
      },
    ),
    "keyboard help must be above terminal and app panes",
  );
  await page.screenshot({ path: resolve(evidence, "keyboard-help.png") });
  report.checks.push("Cmd+? shows layout shortcuts and their setting without an Arrange screen");
  const beforeModal = await page.getByTestId("general-window-claude").getAttribute("data-active");
  await page.keyboard.press("Control+Alt+ArrowRight");
  assert.equal(
    await page.getByTestId("general-window-claude").getAttribute("data-active"),
    beforeModal,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Keyboard Shortcuts" }).waitFor({ state: "hidden" });
  report.checks.push("layout shortcuts do not run behind a modal");
  await page.getByLabel("claude input").focus();
  await page.keyboard.press("Control+Alt+KeyN");
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId("workspace-board-tablist").getByRole("tab").count(), 2);
  assert.deepEqual((await page.evaluate(() => window.fixture)).mounts, initial.mounts);
  report.checks.push("move to another board preserves terminal instance");
  await page.keyboard.press("Control+Alt+PageUp");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("iframe").getAttribute("data-instance"), "original");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("hive:terminal-notification-focus", {
        cancelable: true,
        detail: { workspaceId: "software", sessionName: "claude" },
      }),
    ),
  );
  await page.waitForTimeout(150);
  assert.equal(await page.getByTestId("general-window-claude").getAttribute("data-active"), "true");
  assert.equal(await page.getByTestId("workspace-board-tablist").getByRole("tab").count(), 2);
  report.checks.push("notification reveals the existing pane on another board");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("hive:terminal-notification-focus", {
        cancelable: true,
        detail: { workspaceId: "software", sessionName: "notice" },
      }),
    ),
  );
  await page.getByLabel("notice input").waitFor();
  assert.equal(await page.getByTestId("workspace-board-tablist").getByRole("tab").count(), 3);
  report.checks.push("missing notification creates a new board and terminal window");
  await page.keyboard.press("Control+1");
  await page.waitForTimeout(150);
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => localStorage.getItem("general-workspace:v1:fixture"));
  await page.reload();
  await page.getByLabel("codex input").waitFor();
  assert.deepEqual(
    JSON.parse(await page.evaluate(() => localStorage.getItem("general-workspace:v1:fixture"))),
    JSON.parse(saved),
  );
  report.checks.push("reload retains dimensions, mode and grouping");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert(
    await page
      .locator('[data-workspace-window-id="codex"]')
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) < 0.001),
  );
  report.checks.push("reduced motion disables pane transitions");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(evidence, "mobile.png") });
  report.checks.push("mobile single pane without horizontal page overflow");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("http://127.0.0.1:8831/?collapsible=1");
  await page.getByRole("button", { name: "Workspace apps" }).click();
  await page.waitForTimeout(250);
  const panel = page.locator('[data-slot="collapsible-content"]');
  const panelHeight = (await panel.boundingBox()).height;
  assert(panelHeight > 0);
  await page.getByRole("button", { name: "Workspace apps" }).click();
  await page.waitForTimeout(60);
  const during = await panel.boundingBox();
  assert(during && during.height > 0 && during.height < panelHeight);
  await page.waitForTimeout(250);
  assert.equal(await panel.isVisible(), false);
  report.checks.push("Base UI collapsible animates its measured height before unmounting");

  const reviewContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const review = await reviewContext.newPage();
  review.on("pageerror", (error) => report.errors.push(error.message));
  await review.goto("http://127.0.0.1:8831");
  await review.getByRole("button", { name: "Close Files window", exact: true }).click();
  await review.getByRole("button", { name: "Strip layout", exact: true }).click();
  await review.getByLabel("claude input").focus();
  const openFiles = () =>
    review.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("hive:workspace-open", {
          detail: { workspaceId: "software", tool: "files" },
        }),
      ),
    );
  await openFiles();
  await review.frameLocator("iframe").getByLabel("File draft").waitFor();
  await review.waitForTimeout(250);
  const filesWindow = review
    .locator("[data-workspace-window-id]")
    .filter({ has: review.getByTestId("general-app-files") });
  const opened = await filesWindow.boundingBox();
  assert(
    opened.x >= 0 && opened.x + opened.width <= 1200,
    "newly opened third app must be in view",
  );
  report.checks.push("opening a third Strip app reveals it immediately");

  await review
    .locator('[data-window-layout="strip"]')
    .evaluate((el) =>
      el.firstElementChild.dispatchEvent(new WheelEvent("wheel", { deltaX: -1200, bubbles: true })),
    );
  await review.waitForTimeout(250);
  assert(
    (await filesWindow.boundingBox()).x >= 1200,
    "manual scroll may leave the active app offscreen",
  );
  await openFiles();
  await review.waitForTimeout(250);
  const reopened = await filesWindow.boundingBox();
  assert(
    reopened.x >= 0 && reopened.x + reopened.width <= 1200,
    "reopening the active app must reveal it",
  );
  assert.equal(await review.locator("[data-workspace-window-id]").count(), 3);
  report.checks.push(
    "reopening the active Strip app reveals it without duplication or blocking manual scroll",
  );

  // Tab B must stay visible when focus moves to the app in the next column.
  await review.getByRole("button", { name: "Strip layout", exact: true }).focus();
  await review.keyboard.press("Control+Alt+Digit2");
  await review.getByLabel("claude input").focus();
  await review.keyboard.press("Control+Alt+BracketRight");
  await review.keyboard.press("Control+Alt+Shift+KeyT");
  const tabs = review.getByRole("tablist", { name: "Column windows" });
  await tabs.getByRole("tab", { name: "codex", exact: true }).click();
  await tabs.getByRole("tab", { name: "claude", exact: true }).click();
  await review.keyboard.press("Control+Alt+Digit3");
  assert.equal(
    await tabs.getByRole("tab", { name: "claude", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await review.waitForTimeout(200);
  await review.reload();
  await tabs.getByRole("tab", { name: "claude", exact: true }).waitFor();
  assert.equal(
    await tabs.getByRole("tab", { name: "claude", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  report.checks.push("clicked tab selection survives focus leaving the column and reload");
  await tabs.getByRole("tab", { name: "codex", exact: true }).click();
  await review.getByLabel("codex input").focus();
  await review.keyboard.press("Control+Alt+ArrowDown");
  await review.keyboard.press("Control+Alt+ArrowRight");
  assert.equal(
    await tabs.getByRole("tab", { name: "claude", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  report.checks.push(
    "keyboard tab selection stays visible after directional focus leaves the column",
  );
  await review.getByRole("button", { name: "Grid layout", exact: true }).click();
  await review.getByLabel("claude input").focus();
  await review.keyboard.press("Control+Alt+KeyF");
  await review.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("hive:workspace-open", {
        detail: { workspaceId: "software", tool: "code" },
      }),
    ),
  );
  await review.waitForTimeout(250);
  assert(
    await review.getByTestId("general-app-code").isVisible(),
    "new app must replace the maximized pane",
  );
  const codeWindow = review
    .locator("[data-workspace-window-id]")
    .filter({ has: review.getByTestId("general-app-code") });
  assert.equal((await codeWindow.boundingBox()).width, 1200);
  report.checks.push("opening a new app transfers Grid maximization to the visible active pane");
  await openFiles();
  await review.waitForTimeout(250);
  assert(
    await review.getByTestId("general-app-files").isVisible(),
    "existing app must replace the maximized pane",
  );
  assert.equal((await filesWindow.boundingBox()).width, 1200);
  report.checks.push(
    "reopening an existing app transfers Grid maximization to the visible active pane",
  );

  await review.getByRole("button", { name: "Strip layout", exact: true }).click();
  await review.keyboard.press("Control+k");
  const search = review.getByPlaceholder("Search terminals, repositories, apps, and commands…");
  await search.fill("hive");
  await review.getByText("hive", { exact: true }).waitFor();
  await search.fill("Use Grid layout");
  await review.getByText("Use Grid layout", { exact: true }).click();
  assert.equal(
    await review.locator("[data-window-layout]").getAttribute("data-window-layout"),
    "grid",
  );
  await review.keyboard.press("Control+Shift+Slash");
  await review.getByLabel("Layout shortcuts").selectOption("off");
  await review.keyboard.press("Escape");
  await review.keyboard.press("Control+k");
  await search.fill("custom-terminal");
  await review.getByText("New terminal “custom-terminal”", { exact: true }).waitFor();
  await search.fill("claude");
  await review.getByRole("option").filter({ hasText: "claude" }).first().waitFor();
  await search.fill("Files");
  await review.getByRole("option").filter({ hasText: "Files" }).first().waitFor();
  await search.fill("Use Strip layout");
  await review.getByText("Use Strip layout", { exact: true }).click();
  assert.equal(
    await review.locator("[data-window-layout]").getAttribute("data-window-layout"),
    "strip",
  );
  report.checks.push(
    "production Cmd+K retains discovery and layout actions across layout and shortcut-preset changes",
  );
  await reviewContext.close();

  const floatingContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const floating = await floatingContext.newPage();
  floating.on("pageerror", (error) => report.errors.push(error.message));
  await floating.goto("http://127.0.0.1:8831");
  await floating.getByRole("button", { name: "Close Files window", exact: true }).click();
  await floating.getByLabel("codex input").focus();
  await floating.keyboard.press("Control+Alt+KeyT");
  await floating.getByLabel("claude input").focus();
  await floating.keyboard.press("Control+Alt+KeyT");
  await floating.keyboard.press("Control+Alt+Digit1");
  await floating.waitForTimeout(250);
  const front = floating.locator('[data-workspace-window-id="codex"]');
  const back = floating.locator('[data-workspace-window-id="claude"]');
  const backRect = await back.boundingBox();
  for (const axis of ["width", "height"]) {
    const before = await front.boundingBox();
    const point =
      axis === "width"
        ? { x: before.x + before.width - 3, y: before.y + 100 }
        : { x: before.x + 100, y: before.y + before.height - 3 };
    const owner = await floating.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest("[data-workspace-window-id]")
          ?.getAttribute("data-workspace-window-id"),
      point,
    );
    assert.equal(owner, "codex", "foreground edge must own the resize hit target");
    await floating.mouse.move(point.x, point.y);
    await floating.mouse.down();
    await floating.mouse.move(
      point.x + (axis === "width" ? 60 : 0),
      point.y + (axis === "height" ? 50 : 0),
      { steps: 8 },
    );
    await floating.mouse.up();
    await floating.waitForTimeout(200);
    assert((await front.boundingBox())[axis] > before[axis] + 30);
    assert.deepEqual(await back.boundingBox(), backRect);
    report.checks.push(`overlapping floating ${axis} handles resize only their foreground owner`);
  }
  const covered = await floating.evaluate(
    ({ x, y }) => ({
      owner: document
        .elementFromPoint(x, y)
        ?.closest("[data-workspace-window-id]")
        ?.getAttribute("data-workspace-window-id"),
      resize: !!document.elementFromPoint(x, y)?.closest("[data-window-resize]"),
    }),
    { x: backRect.x + backRect.width - 3, y: backRect.y + 100 },
  );
  assert.deepEqual(covered, { owner: "codex", resize: false });
  report.checks.push("background floating resize handles cannot intercept foreground content");
  await floatingContext.close();

  const navigationContext = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  });
  const navigation = await navigationContext.newPage();
  navigation.on("pageerror", (error) => report.errors.push(error.message));
  await navigation.goto("http://127.0.0.1:8831");
  await navigation.getByLabel("codex input").waitFor();
  const paneRects = () =>
    navigation.locator("[data-workspace-window-id]").evaluateAll((panes) =>
      panes.map((pane) => {
        const { x, y, width, height } = pane.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  for (const mode of ["Grid", "Strip"]) {
    await navigation.getByRole("button", { name: `${mode} layout`, exact: true }).click();
    await navigation.waitForTimeout(200);
    const rects = await paneRects();
    await navigation.keyboard.press("Control+b");
    await navigation.waitForTimeout(250);
    assert.deepEqual(await paneRects(), rects, "sidebar opening must not move or resize windows");
    assert(
      await navigation.evaluate(
        () => !!document.elementFromPoint(100, 180)?.closest('[data-slot="sidebar-inner"]'),
      ),
    );
    await navigation.keyboard.press("Escape");
    await navigation.waitForTimeout(250);
    assert.deepEqual(await paneRects(), rects, "sidebar closing must not move or resize windows");
  }
  report.checks.push("sidebar overlays Grid and Strip panes without changing their geometry");
  assert.equal(await navigation.getByRole("slider", { name: "Scroll windows" }).count(), 0);
  assert.equal(await navigation.getByRole("toolbar", { name: "Strip overview" }).count(), 0);
  await navigation.getByLabel("codex input").focus();
  await navigation.keyboard.press("Meta+ArrowRight");
  assert.equal(
    await navigation.getByTestId("general-window-claude").getAttribute("data-active"),
    "true",
  );
  await navigation.keyboard.press("Meta+ArrowLeft");
  assert.equal(
    await navigation.getByTestId("general-window-codex").getAttribute("data-active"),
    "true",
  );
  report.checks.push("Cmd+Left/Right focuses adjacent windows from a terminal");
  const scroll = () =>
    navigation.evaluate(
      () =>
        JSON.parse(localStorage.getItem("general-workspace:v1:fixture")).boards[0].manager.scroll,
    );
  const wheel = (init) =>
    navigation.getByLabel("codex input").evaluate((el, init) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
  await wheel({ deltaX: -10000 });
  await navigation.waitForTimeout(200);
  assert.equal(await scroll(), 0);
  const burst = await navigation.getByLabel("codex input").evaluate((el) => {
    let consumed = 0;
    const terminalWheel = (event) => {
      consumed++;
      event.stopPropagation();
    };
    el.addEventListener("wheel", terminalWheel);
    const prevented = [];
    for (let i = 0; i < 12; i++) {
      const event = new WheelEvent("wheel", { deltaX: 8, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      prevented.push(event.defaultPrevented);
    }
    el.removeEventListener("wheel", terminalWheel);
    return { consumed, prevented };
  });
  await navigation.waitForTimeout(250);
  assert.equal(await scroll(), 96, "all rapid trackpad deltas must accumulate");
  assert.deepEqual(burst, { consumed: 0, prevented: Array(12).fill(true) });
  assert.equal(await wheel({ deltaX: 1, deltaY: 40 }), false);
  assert.equal(await wheel({ deltaX: 40, ctrlKey: true }), false);
  await navigation.waitForTimeout(200);
  assert.equal(await scroll(), 96, "vertical scroll and pinch zoom must not move the strip");
  await wheel({ deltaY: 3, shiftKey: true, deltaMode: 1 });
  await navigation.waitForTimeout(200);
  assert.equal(await scroll(), 144);
  await wheel({ deltaX: -64 });
  await navigation.waitForTimeout(200);
  assert.equal(await scroll(), 80);
  await navigation.screenshot({ path: resolve(evidence, "strip-without-slider.png") });
  report.checks.push(
    "horizontal wheel capture accumulates bursts, normalizes line deltas, and preserves vertical scroll and zoom",
  );
  await navigationContext.close();
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(resolve(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  await browser.close();
  server.close();
  app.close();
}
