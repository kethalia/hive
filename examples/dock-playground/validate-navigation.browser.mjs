import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/navigation");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const url = process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318";
const dock = page.getByRole("navigation", { name: "Workspace dock" });
const back = dock.getByRole("button", { name: "Back to main dock" });
const settled = () => expect(dock).toHaveAttribute("aria-busy", "false");
const offset = (button) =>
  button.evaluate((node) => {
    const m = new DOMMatrix(getComputedStyle(node).transform);
    return [Math.round(m.m41), Math.round(m.m42)];
  });
async function recordTransition(name, next) {
  await dock.getByRole("button", { name, exact: true }).click();
  await expect(dock).toHaveAttribute("aria-busy", "true");
  const frames = await dock.evaluate(
    (node) =>
      new Promise((resolve) => {
        const frames = [],
          start = performance.now();
        const sample = () => {
          frames.push({
            time: Math.round(performance.now() - start),
            width: node.getBoundingClientRect().width,
            view: node.dataset.view,
            opacity: getComputedStyle(node.querySelector(".hive-dock-panel")).opacity,
          });
          if (node.getAttribute("aria-busy") === "false" || performance.now() - start > 2500)
            resolve(frames);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  assert.ok(frames.length > 12, "Transition spans multiple visible frames");
  assert.ok(
    new Set(frames.map((frame) => Math.round(frame.width))).size > 8,
    "Tray changes size progressively",
  );
  await expect(dock).toHaveAttribute("data-view", next);
  await settled();
  await writeFile(resolve(output, `transition-${next}.json`), JSON.stringify(frames, null, 2));
}
try {
  await page.goto(url);
  await recordTransition("Extra keyboard", "keyboard");
  await expect(back).toBeFocused();
  for (const modifier of ["Ctrl", "Alt"]) {
    const key = dock.getByRole("button", { name: `${modifier} modifier` });
    await key.click();
    await expect(key).toHaveAttribute("aria-pressed", "true");
    await key.hover();
    await expect.poll(() => offset(key)).toEqual([-3, 4]);
    await page.mouse.move(20, 20);
    await expect.poll(() => offset(key)).toEqual([-3, 4]);
  }
  await dock.screenshot({ path: resolve(output, "latched-modifiers.png") });
  const options = dock.locator(".hive-dock-options");
  const right = dock.getByRole("button", { name: "Scroll keys right" });
  await expect(right).toBeVisible();
  assert.equal(await options.evaluate((node) => getComputedStyle(node).scrollbarWidth), "none");
  await right.click();
  await expect.poll(() => options.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await expect(back).toBeInViewport();
  await options.hover();
  const beforeWheel = await options.evaluate((node) => node.scrollLeft);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => options.evaluate((node) => node.scrollLeft)).toBeGreaterThan(beforeWheel);
  await dock.screenshot({ path: resolve(output, "keyboard-overflow.png") });
  await recordTransition("Back to main dock", "home");
  await expect(dock.getByRole("button", { name: "Extra keyboard" })).toBeFocused();
  checks.push(
    "Exit, tray resize, and entrance animate across visible frames in both directions; modifiers stay physically down while latched; scrollbar-free arrows and vertical-wheel navigation work.",
  );

  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await settled();
  const create = dock.getByRole("button", { name: "Create workspace" });
  await expect(dock.getByRole("button", { name: /^Remove workspace/ })).toHaveCount(0);
  await create.click();
  await create.click();
  await dock.getByRole("button", { name: "Workspace 2: Workspace 2", exact: true }).click();
  const selected = dock.getByRole("button", { name: "Workspace 2: Workspace 2", exact: true });
  await expect.poll(() => offset(selected)).toEqual([-3, 4]);
  await selected.hover();
  await expect.poll(() => offset(selected)).toEqual([-3, 4]);
  await expect(dock.getByRole("button", { name: /^Remove workspace/ })).toHaveCount(1);
  await dock.screenshot({ path: resolve(output, "selected-space-remove.png") });
  await dock.getByRole("button", { name: "Remove workspace 2", exact: true }).click();
  await expect(dock.locator(".hive-dock-space")).toHaveCount(2);
  await expect(
    dock.getByRole("button", { name: "Workspace 1: Workspace 1", exact: true }),
  ).toBeFocused();
  await dock.getByRole("button", { name: "Remove workspace 1", exact: true }).click();
  await expect(dock.locator(".hive-dock-space")).toHaveCount(1);
  await expect(dock.getByRole("button", { name: /^Remove workspace/ })).toHaveCount(0);
  checks.push(
    "Only the selected space has a round removal control; selection stays depressed; removing it updates boards and restores focus; the last space remains.",
  );

  await page.setViewportSize({ width: 320, height: 844 });
  for (let index = 0; index < 8; index++) await create.click();
  await expect(
    dock.getByRole("button", { name: "Workspace 9: Workspace 9", exact: true }),
  ).toBeInViewport();
  await expect(back).toBeInViewport();
  await expect(create).toBeInViewport();
  const spaces = dock.locator(".hive-dock-options");
  const endScroll = await spaces.evaluate((node) => node.scrollLeft);
  await dock.getByRole("button", { name: "Scroll spaces left" }).click();
  await expect.poll(() => spaces.evaluate((node) => node.scrollLeft)).toBeLessThan(endScroll);
  await expect(back).toBeInViewport();
  await expect(create).toBeInViewport();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await dock.screenshot({ path: resolve(output, "spaces-mobile-scroll.png") });
  await back.click();
  await settled();
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dock).toHaveAttribute("data-view", "home");
  await settled();
  await expect(dock.getByRole("button", { name: "Workspaces", exact: true })).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dock.getByRole("button", { name: "Extra keyboard", exact: true }).click();
  await settled();
  assert.equal(
    await dock.evaluate(
      (node) =>
        node
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running").length,
    ),
    0,
  );
  checks.push(
    "At 320px active spaces reveal automatically, Back/+ stay fixed, arrows do not snap back to selection, rapid Escape returns safely, and reduced-motion view changes are immediate.",
  );
  const touchContext = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const touchPage = await touchContext.newPage();
  touchPage.on("pageerror", (error) => errors.push(error.message));
  await touchPage.goto(url);
  await touchPage.getByRole("button", { name: "Extra keyboard", exact: true }).tap();
  const touchDock = touchPage.getByRole("navigation", { name: "Workspace dock" });
  await expect(touchDock).toHaveAttribute("aria-busy", "false");
  const touchOptions = touchDock.locator(".hive-dock-options");
  const bounds = await touchOptions.boundingBox();
  const cdp = await touchContext.newCDPSession(touchPage);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: bounds.x + bounds.width - 12, y: bounds.y + bounds.height / 2 }],
  });
  for (let step = 1; step <= 6; step++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: bounds.x + bounds.width - 12 - (step * (bounds.width - 24)) / 6,
          y: bounds.y + bounds.height / 2,
        },
      ],
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => touchOptions.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await expect(touchDock.getByRole("button", { name: "Back to main dock" })).toBeInViewport();
  await expect(touchDock.locator('[data-depressed="true"]')).toHaveCount(0);
  await touchContext.close();
  checks.push(
    "Real touch swiping moves the key strip while Back stays fixed and cancelled key presses release.",
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
