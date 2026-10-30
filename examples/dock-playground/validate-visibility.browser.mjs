import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/visibility");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const url = process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318";
const overlay = page.locator(".hive-dock-overlay"),
  content = page.locator(".hive-dock-overlay-content"),
  toggle = page.locator(".hive-dock-toggle"),
  dock = page.getByRole("navigation", { name: "Workspace dock" });
const hidden = async () => {
  await expect(toggle).toHaveAccessibleName("Show dock");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(content).toHaveAttribute("inert", "");
  await expect(content).toHaveAttribute("aria-hidden", "true");
  await expect(dock).toHaveCount(0);
};
const shown = async () => {
  await expect(toggle).toHaveAccessibleName("Hide dock");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(content).not.toHaveAttribute("inert", "");
  await expect(dock).toBeVisible();
};
async function fullCanvas(target = page) {
  // Viewport events are coalesced into rAF; advance the mocked clock after the
  // browser dispatches resize, rather than assuming that dispatch is synchronous.
  await expect
    .poll(async () => {
      await target.clock.runFor(50);
      const bounds = await target.getByTestId("workspace-canvas").boundingBox();
      return bounds.height - (await target.evaluate(() => innerHeight));
    })
    .toBe(0);
  const bounds = await target.getByTestId("workspace-canvas").boundingBox();
  const height = await target.evaluate(() => innerHeight);
  assert.equal(bounds.y, 0);
  assert.equal(bounds.height, height, "The overlay reserves no footer space");
}

try {
  await page.clock.install();
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await fullCanvas();
  await shown();
  await page.clock.fastForward(2600);
  await hidden();
  await expect(content).toHaveCSS("opacity", "0");
  await page.screenshot({ path: resolve(output, "empty-hidden.png") });

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Add window", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await shown();
  await expect(toggle).toBeFocused();
  await page.clock.fastForward(2600);
  await hidden();
  await expect(toggle).toBeFocused();
  await toggle.press("Space");
  await shown();
  await page.keyboard.press("Tab");
  await expect(dock.getByRole("button", { name: "Apps", exact: true })).toBeFocused();
  await page.clock.fastForward(5000);
  await shown();
  await page.keyboard.press("Shift+Tab");
  await expect(toggle).toBeFocused();
  await page.clock.fastForward(2600);
  await hidden();
  checks.push(
    "The persistent 44px handle is reachable with Tab, Enter/Space show it, manual show resumes auto-hide, and focused controls stay available without trapping focus.",
  );

  await toggle.click();
  await dock.getByRole("button", { name: "Workspaces", exact: true }).hover();
  await page.clock.fastForward(5000);
  await shown();
  await page.mouse.move(20, 20);
  await page.clock.fastForward(2600);
  await hidden();
  await page.keyboard.press("Alt+Shift+KeyD");
  await shown();
  await expect(dock.getByRole("button", { name: "Apps", exact: true })).toBeFocused();
  await page.keyboard.press("Alt+Shift+KeyD");
  await hidden();
  await expect(toggle).toBeFocused();
  checks.push(
    "Hover holds the dock open; leaving resumes the timer; the shortcut shows/focuses it and safely returns focus on hide.",
  );

  await toggle.click();
  await dock.getByRole("button", { name: "Apps", exact: true }).click();
  await page.mouse.move(20, 20);
  await page.clock.fastForward(6000);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(overlay).toHaveAttribute("data-dock-visible", "true");
  await page.keyboard.press("Alt+Shift+KeyD");
  await expect(overlay).toHaveAttribute("data-dock-visible", "true");
  await page.getByRole("option", { name: "Terminal ai-dev-01", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: /^Terminal input/ }).focus();
  await page.clock.fastForward(2600);
  await hidden();
  await fullCanvas();
  await page.screenshot({ path: resolve(output, "full-window-hidden.png") });
  await toggle.click();
  await shown();
  const hit = await dock.getByRole("button", { name: "Apps", exact: true }).evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    return button.contains(
      document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
    );
  });
  assert.ok(hit, "Dock controls sit above full-height windows");
  const handleBounds = await toggle.boundingBox();
  assert.equal(handleBounds.width, 32);
  assert.equal(handleBounds.height, 32);
  assert.ok(
    await toggle.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const hits = [
        [bounds.x - 5, bounds.y + 16],
        [bounds.right + 5, bounds.y + 16],
        [bounds.x + 16, bounds.y - 5],
        [bounds.x + 16, bounds.bottom + 5],
      ];
      return hits.every(([x, y]) => button.contains(document.elementFromPoint(x, y)));
    }),
    "The 32px visual handle retains its expanded 44px hit target",
  );
  const dockBounds = await dock.boundingBox();
  assert.ok(
    handleBounds.x >= dockBounds.x + dockBounds.width &&
      handleBounds.y >= dockBounds.y &&
      handleBounds.y + handleBounds.height <= dockBounds.y + dockBounds.height,
    "The compact handle sits beside the dock and adds no extra row",
  );
  await fullCanvas();
  await page.screenshot({ path: resolve(output, "full-window-overlay.png") });
  checks.push(
    "Dialogs suspend auto-hide and retain their own shortcuts/focus. Windows use the full canvas while the dock overlays them and remains clickable.",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await toggle.click();
  await hidden();
  await expect(content).toHaveCSS("transition-duration", "0s");
  await toggle.click();
  await shown();
  await expect(content).toHaveCSS("transform", "none");

  const mobile = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const touch = await mobile.newPage();
  touch.on("pageerror", (error) => errors.push(error.message));
  await touch.clock.install();
  await touch.goto(url);
  await touch.clock.fastForward(2600);
  const touchToggle = touch.locator(".hive-dock-toggle");
  await expect(touchToggle).toHaveAccessibleName("Show dock");
  await touchToggle.tap();
  await expect(touchToggle).toHaveAccessibleName("Hide dock");
  await touch.clock.fastForward(2600);
  await expect(touchToggle).toHaveAccessibleName("Show dock");
  await touchToggle.tap();
  await touch.getByRole("button", { name: "Workspaces", exact: true }).tap();
  const touchDock = touch.getByRole("navigation", { name: "Workspace dock" });
  await expect(touchDock).toHaveAttribute("aria-busy", "false");
  await touch.clock.fastForward(5000);
  await expect(touchToggle).toHaveAccessibleName("Hide dock");
  await touchToggle.tap();
  await expect(touchToggle).toHaveAccessibleName("Show dock");
  await touchToggle.tap();
  await expect(touchDock).toHaveAttribute("data-view", "workspaces");
  await fullCanvas(touch);
  assert.ok(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await expect(touch.locator(".hive-dock-overlay-content")).toHaveCSS("opacity", "1");
  await touch.screenshot({ path: resolve(output, "touch-spaces-overlay.png") });
  await touch.setViewportSize({ width: 320, height: 480 });
  await touch.clock.runFor(100);
  await fullCanvas(touch);
  const smallHandle = await touchToggle.boundingBox();
  assert.ok(smallHandle.y >= 0 && smallHandle.y + smallHandle.height <= 480);
  await mobile.close();
  checks.push(
    "Reduced motion removes reveal transitions. At 320px the first tap shows the dock, inactivity hides it again, navigation survives hide/show, and the full canvas and handle track viewport resizing.",
  );

  assert.deepEqual(errors, []);
  const results = { passed: true, checks, browserErrors: errors };
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser.close();
}
