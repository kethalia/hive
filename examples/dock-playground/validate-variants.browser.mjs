import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/variants");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const dock = page.getByRole("navigation", { name: "Workspace dock" });
const picker = page.getByRole("group", { name: "Dock style", exact: true });
const url = process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318";
const variants = ["phosphor", "outline", "keycaps", "console", "glass"];
async function screenshot(name) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
}
async function fits() {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "No page overflow",
  );
  const rect = await dock.boundingBox();
  const width = page.viewportSize().width;
  assert.ok(rect.x >= 0 && rect.x + rect.width <= width, `Dock within ${width}px viewport`);
  for (const button of await dock.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    assert.ok(bounds.height >= 40, "Controls retain a usable height");
  }
}
try {
  for (const variant of variants) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${url}/?dock=${variant}`);
    await expect(dock).toHaveAttribute("data-variant", variant);
    await expect(dock.getByRole("button")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const fill = await dock
      .getByRole("button", { name: "Apps", exact: true })
      .evaluate((node) => getComputedStyle(node).backgroundImage);
    assert.equal(fill === "none", variant !== "glass", "Native variants avoid glossy gradients");
    await screenshot(`${variant}-desktop-home`);
    await dock.getByRole("button", { name: "Apps", exact: true }).click();
    await page.getByRole("option", { name: "Terminal ai-dev-01", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
    await dock.getByRole("button", { name: "Create workspace" }).click();
    await dock.getByRole("button", { name: "Workspace 1: Workspace 1", exact: true }).click();
    await screenshot(`${variant}-desktop-workspaces`);
    await dock.getByRole("button", { name: "Back to main dock" }).click();
    await dock.getByRole("button", { name: "Extra keyboard" }).click();
    await dock.getByRole("button", { name: "Ctrl modifier" }).click();
    await dock.getByRole("button", { name: "Ctrl+Up", exact: true }).click();
    await expect(page.locator(".prototype-status")).toContainText("1;5A");
    await expect(dock.getByRole("button", { name: "Ctrl modifier" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await screenshot(`${variant}-desktop-keyboard`);
    await dock.getByRole("button", { name: "Back to main dock" }).click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await fits();
      await screenshot(`${variant}-mobile-${width}-home`);
      await dock.getByRole("button", { name: "Extra keyboard" }).click();
      await dock
        .getByRole("button", { name: "Upload files", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeInViewport();
      await expect(
        dock.getByRole("button", { name: "Upload files", exact: true }),
      ).toBeInViewport();
      await fits();
      await screenshot(`${variant}-mobile-${width}-keyboard`);
      await dock.getByRole("button", { name: "Back to main dock" }).click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Playground controls" }).click();
    await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("light");
    await page.getByRole("combobox", { name: "Dock size", exact: true }).selectOption("compact");
    await page.keyboard.press("Escape");
    await screenshot(`${variant}-light-compact`);
    await page.reload();
    await expect(dock).toHaveAttribute("data-variant", variant);
    checks.push(
      `${variant}: home/workspace/keyboard states, encoded modifiers, 320px/390px reachability, light compact theme, and shareable URL reload pass.`,
    );
  }
  await page.goto(`${url}/?dock=unknown`);
  await expect(dock).toHaveAttribute("data-variant", "keycaps");
  await picker.getByRole("button", { name: "Keycaps", exact: true }).click();
  await expect(dock).toHaveAttribute("data-variant", "keycaps");
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await picker.getByRole("button", { name: "Console", exact: true }).click();
  await expect(dock).toHaveAttribute("data-view", "workspaces");
  await dock.getByRole("button", { name: "Back to main dock" }).click();
  await picker.getByRole("button", { name: "Phosphor", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.getByRole("button", { name: "Compare dock styles" }).click();
  const comparison = page.getByRole("dialog");
  await expect(comparison.getByRole("heading", { name: "Dock styles", exact: true })).toBeVisible();
  await expect(comparison.getByRole("button", { name: /^Try / })).toHaveCount(5);
  await comparison.screenshot({
    path: resolve(output, "dock-styles-comparison.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Try Outline", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(dock).toHaveAttribute("data-variant", "outline");
  await expect(page.getByRole("button", { name: "Compare dock styles" })).toBeFocused();
  checks.push(
    "Switcher preserves expanded view; unknown styles fall back safely; side-by-side comparison previews are inert and Try applies a style with restored focus.",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${url}/?dock=keycaps`);
  await dock.getByRole("button", { name: "Extra keyboard" }).click();
  const cap = dock.getByRole("button", { name: "Ctrl modifier", exact: true });
  const position = (button) =>
    button.evaluate((node) => {
      const matrix = new DOMMatrix(getComputedStyle(node).transform);
      return [Math.round(matrix.m41 * 10) / 10, Math.round(matrix.m42 * 10) / 10];
    });
  await page.mouse.move(40, 40);
  await expect.poll(() => position(cap)).toEqual([0, 0]);
  const restShadow = await cap.evaluate((node) => getComputedStyle(node).boxShadow);
  assert.ok(restShadow.includes("-4px 5px"), "Keycap side edge extends to the bottom-left");
  await dock.screenshot({ path: resolve(output, "keycaps-rest.png") });
  await cap.hover();
  await expect.poll(() => position(cap)).toEqual([2, -3]);
  const hoverShadow = await cap.evaluate((node) => getComputedStyle(node).boxShadow);
  assert.notEqual(hoverShadow, restShadow);
  await dock.screenshot({ path: resolve(output, "keycaps-hover.png") });
  await page.mouse.down();
  await expect.poll(() => position(cap)).toEqual([-3, 4]);
  assert.equal(
    await cap.evaluate((node) => getComputedStyle(node).scale),
    "1",
    "Press translates instead of shrinking the cap",
  );
  await dock.screenshot({ path: resolve(output, "keycaps-press.png") });
  await page.mouse.up();
  await expect(cap).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => position(cap)).toEqual([2, -3]);
  await page.mouse.move(40, 40);
  await expect.poll(() => position(cap)).toEqual([0, 0]);
  await cap.focus();
  for (const key of ["Space", "Enter"]) {
    await page.keyboard.down(key);
    await expect(cap).toHaveAttribute("data-depressed", "true");
    await expect.poll(() => position(cap)).toEqual([-3, 4]);
    await page.keyboard.up(key);
    await expect(cap).not.toHaveAttribute("data-depressed", "true");
    await expect.poll(() => position(cap)).toEqual([0, 0]);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await cap.hover();
  await expect.poll(() => position(cap)).toEqual([0, 0]);
  assert.equal(await cap.evaluate((node) => getComputedStyle(node).transitionProperty), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const touchContext = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const touchPage = await touchContext.newPage();
  touchPage.on("pageerror", (error) => errors.push(error.message));
  await touchPage.goto(`${url}/?dock=keycaps`);
  await touchPage.getByRole("button", { name: "Extra keyboard", exact: true }).tap();
  const touchCap = touchPage.getByRole("button", { name: "Ctrl modifier", exact: true });
  const bounds = await touchCap.boundingBox();
  const cdp = await touchContext.newCDPSession(touchPage);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
  });
  await expect.poll(() => position(touchCap)).toEqual([-3, 4]);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => position(touchCap)).toEqual([0, 0]);
  await expect(touchCap).toHaveAttribute("aria-pressed", "true");
  await touchContext.close();
  checks.push(
    "Keycaps: bottom-left side edge, inverse hover lift, mouse press/release, Space/Enter activation, touch press/release without sticky lift, and reduced motion pass.",
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
