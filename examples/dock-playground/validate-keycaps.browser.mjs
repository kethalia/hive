import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/keycaps");
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
const url = process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318";
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
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
  await expect.poll(() => position(cap)).toEqual([-3, 4]);
  await page.mouse.move(40, 40);
  await expect.poll(() => position(cap)).toEqual([-3, 4]);
  await cap.focus();
  for (const key of ["Space", "Enter"]) {
    await page.keyboard.down(key);
    await expect(cap).toHaveAttribute("data-depressed", "true");
    await expect.poll(() => position(cap)).toEqual([-3, 4]);
    await page.keyboard.up(key);
    await expect(cap).not.toHaveAttribute("data-depressed", "true");
    await expect.poll(() => position(cap)).toEqual(key === "Space" ? [0, 0] : [-3, 4]);
  }
  await cap.click();
  await expect(cap).toHaveAttribute("aria-pressed", "false");
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
  await touchPage.goto(url);
  await touchPage.getByRole("button", { name: "Extra keyboard", exact: true }).tap();
  await expect(touchPage.getByRole("navigation", { name: "Workspace dock" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const touchCap = touchPage.getByRole("button", { name: "Ctrl modifier", exact: true });
  const bounds = await touchCap.boundingBox();
  const cdp = await touchContext.newCDPSession(touchPage);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
  });
  await expect.poll(() => position(touchCap)).toEqual([-3, 4]);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => position(touchCap)).toEqual([-3, 4]);
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
