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
  await page.getByRole("button", { name: "Arrange windows and shortcuts" }).click();
  const beforeModal = await page.getByTestId("general-window-claude").getAttribute("data-active");
  await page.keyboard.press("Control+Alt+ArrowRight");
  assert.equal(
    await page.getByTestId("general-window-claude").getAttribute("data-active"),
    beforeModal,
  );
  await page.keyboard.press("Escape");
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
  await review.getByRole("button", { name: "Focus claude", exact: true }).click();
  await review.getByLabel("claude input").focus();
  await review.keyboard.press("Control+Alt+BracketRight");
  await review.keyboard.press("Control+Alt+Shift+KeyT");
  const tabs = review.getByRole("tablist", { name: "Column windows" });
  await tabs.getByRole("tab", { name: "codex", exact: true }).click();
  await tabs.getByRole("tab", { name: "claude", exact: true }).click();
  await review.getByRole("button", { name: "Focus Files", exact: true }).click();
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
  await reviewContext.close();
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(resolve(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  await browser.close();
  server.close();
  app.close();
}
