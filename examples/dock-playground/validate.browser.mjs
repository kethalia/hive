import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/evidence");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const failures = [],
  checks = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) => failures.push(error.message));
const dock = page.getByRole("navigation", { name: "Workspace dock" });
const status = page.locator(".prototype-status");
const frames = page.locator("[data-workspace-window-id]:visible");
async function screenshot(name) {
  await expect(dock).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: resolve(output, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
async function openApp(name) {
  await dock.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByRole("option", { name: `${name} ai-dev-01`, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function settings() {
  await page.getByRole("button", { name: "Playground controls" }).click();
}
async function reset() {
  await settings();
  await page.getByRole("button", { name: "Reset playground" }).click();
}
try {
  assert.equal(
    (await page.goto(process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318")).status(),
    200,
  );
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { name: "Your workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add window", exact: true })).toBeVisible();
  await expect(dock.getByRole("button")).toHaveCount(4);
  const nativeStyle = await page.locator("main").evaluate((node) => ({
    font: getComputedStyle(node).fontFamily,
    background: getComputedStyle(document.body).backgroundColor,
    grid: node.classList.contains("crt-grid"),
    scanlines: node.classList.contains("crt-scanlines"),
    height: node.getBoundingClientRect().height,
    viewport: innerHeight,
  }));
  assert.ok(nativeStyle.font.includes("Fira Code"));
  assert.equal(nativeStyle.background, "rgb(7, 10, 8)");
  assert.ok(nativeStyle.grid && nativeStyle.scanlines);
  assert.equal(nativeStyle.height, nativeStyle.viewport);
  await expect(page.getByText("Everything, within reach.")).toHaveCount(0);
  await screenshot("hive-empty-dock");
  checks.push(
    "Native Hive full-height shell, Fira Code, phosphor colors, CRT classes, and original empty-state copy; invented landing page removed.",
  );

  await page.getByRole("button", { name: "Add window", exact: true }).click();
  await page.getByRole("option", { name: "Terminal ai-dev-01", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(frames).toHaveCount(1);
  const input = page.getByRole("textbox", { name: /^Terminal input/ });
  await input.pressSequentially("echo native-session");
  await input.press("Enter");
  await expect(status).toContainText("native-session");
  await expect(page.locator(".xterm-accessibility-tree")).toContainText("native-session");
  await openApp("Files");
  await expect(frames).toHaveCount(2);
  await expect(page.locator("[data-window-drag-surface='true']")).toHaveCount(2);
  await screenshot("hive-terminal-files-strip");
  await dock.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByRole("option", { name: "Use Grid layout", exact: true }).click();
  await expect(page.locator("[data-window-layout]")).toHaveAttribute("data-window-layout", "grid");
  const divider = page.getByRole("separator").first();
  const before = await divider.getAttribute("aria-valuenow");
  await divider.press("ArrowRight");
  await expect(divider).not.toHaveAttribute("aria-valuenow", before);
  await screenshot("hive-terminal-files-grid");
  await page.getByRole("button", { name: "Close Files window", exact: true }).click();
  await expect(frames).toHaveCount(1);
  checks.push(
    "Actual WindowCanvas and TerminalSessionFrame: terminal/files panes, real xterm input, Strip/Grid switching, keyboard resizing, and close actions work.",
  );

  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeFocused();
  await dock.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Your workspace", exact: true })).toBeVisible();
  await dock.getByRole("button", { name: "Workspace 1: Workspace 1", exact: true }).click();
  await expect(frames).toHaveCount(1);
  await expect(page.locator(".xterm-accessibility-tree").first()).toContainText("native-session");
  await dock.getByRole("button", { name: "Back to main dock" }).press("Escape");
  await expect(dock.getByRole("button", { name: "Workspaces", exact: true })).toBeFocused();
  await dock.getByRole("button", { name: "Extra keyboard" }).click();
  await dock.getByRole("button", { name: "Ctrl modifier" }).click();
  await dock.getByRole("button", { name: "Shift modifier" }).click();
  await dock.getByRole("button", { name: "Ctrl+Shift+Up", exact: true }).click();
  await expect(status).toContainText("1;6A");
  await expect(dock.getByRole("button", { name: "Ctrl modifier" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  for (const name of [
    "Enter",
    "Tab",
    "Esc",
    "Backspace",
    "Up",
    "Down",
    "Left",
    "Right",
    "Space",
    "Copy terminal selection",
    "Paste from clipboard",
    "Upload files",
    "Decrease font size",
    "Increase font size",
  ])
    await expect(dock.getByRole("button", { name, exact: true })).toHaveCount(1);
  await dock.getByRole("button", { name: "Copy terminal selection", exact: true }).click();
  await expect(status).toContainText("Copied");
  await dock.getByRole("button", { name: "Paste from clipboard", exact: true }).click();
  await expect(status).toContainText("Pasted");
  await dock.getByRole("button", { name: "Esc", exact: true }).click();
  await dock.getByRole("button", { name: "Increase font size", exact: true }).click();
  await expect(status).toContainText("14px");
  const picker = page.waitForEvent("filechooser");
  await dock.getByRole("button", { name: "Upload files", exact: true }).click();
  await (await picker).setFiles({
    name: "dock-demo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("local demo"),
  });
  await expect(status).toContainText("dock-demo.txt");
  await screenshot("hive-keyboard-desktop");
  await dock.getByRole("button", { name: "Back to main dock" }).click();
  checks.push(
    "Workspace switching keeps real local terminal buffers; full key inventory, one-shot VT modifiers, clipboard/file/font actions, and focus restoration pass.",
  );

  await settings();
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("current");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("current-workspace-navbar")).toBeVisible();
  await expect(dock).toHaveCount(0);
  await expect(page.getByTestId("workspace-board-bar")).toBeVisible();
  await screenshot("hive-current-navbar");
  await page.getByRole("button", { name: "Search Hive", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await settings();
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("dock");
  await page.getByRole("combobox", { name: "Dock size", exact: true }).selectOption("compact");
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("light");
  await page.keyboard.press("Escape");
  await expect(dock).toHaveAttribute("data-density", "compact");
  await screenshot("hive-light");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await dock.getByRole("button", { name: "Keybinds", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Keyboard Shortcuts");
  await page.keyboard.press("Escape");
  await settings();
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("dark");
  await page.keyboard.press("Escape");
  checks.push(
    "Comparison uses actual WorkspaceSearchButton, WindowLayoutControls, and WorkspaceBoardBar; native theme, density, command palette, and keybind help pass.",
  );

  for (const width of [390, 320]) {
    await reset();
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("heading", { name: "Your workspace", exact: true })).toBeVisible();
    await screenshot(`hive-mobile-${width}-empty`);
    await openApp("Terminal");
    await dock.getByRole("button", { name: "Extra keyboard" }).click();
    await dock.getByRole("button", { name: "Upload files", exact: true }).scrollIntoViewIfNeeded();
    await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeInViewport();
    await expect(dock.getByRole("button", { name: "Upload files", exact: true })).toBeInViewport();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot(`hive-mobile-${width}-keyboard`);
    await dock.getByRole("button", { name: "Back to main dock" }).click();
    await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
    for (let i = 0; i < 8; i++)
      await dock.getByRole("button", { name: "Create workspace" }).click();
    await expect(dock.getByRole("button", { name: "Create workspace" })).toBeDisabled();
    await dock
      .getByRole("button", { name: "Workspace 9: Workspace 9", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeInViewport();
    await screenshot(`hive-mobile-${width}-workspaces`);
    checks.push(
      `${width}px: native empty state and xterm pane fit; no page overflow; scrollable keys/workspaces retain Back; Hive's nine-board limit is respected.`,
    );
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".hive-dock-options")
      .evaluate((node) => getComputedStyle(node).animationName),
    "none",
  );
  assert.deepEqual(failures, [], "No browser exceptions");
  const results = { passed: true, checks, browserErrors: failures };
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await screenshot("failure");
  throw error;
} finally {
  await browser.close();
}
