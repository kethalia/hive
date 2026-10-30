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
  surface = page.locator(".hive-dock-surface");
const expand = page.getByRole("button", { name: "Expand dock", exact: true });
const minimise = page.getByRole("button", { name: "Minimise dock", exact: true });
const grip = page.getByRole("button", { name: "Move dock", exact: true });
const dock = page.getByRole("navigation", { name: "Workspace dock" });
const phase = (name) => expect(overlay).toHaveAttribute("data-phase", name);
async function edge(target = page) {
  await expect
    .poll(async () => {
      const box = await target.locator(".hive-dock-surface").boundingBox();
      const size = target.viewportSize();
      return Math.min(
        Math.abs(box.x - 12),
        Math.abs(box.y - 12),
        Math.abs(size.width - box.x - box.width - 12),
        Math.abs(size.height - box.y - box.height - 12),
      );
    })
    .toBeLessThan(1);
  const box = await target.locator(".hive-dock-surface").boundingBox(),
    size = target.viewportSize();
  assert.ok(
    box.x >= 11 &&
      box.y >= 11 &&
      box.x + box.width <= size.width - 11 &&
      box.y + box.height <= size.height - 11,
  );
}
async function morph(button, name, destination) {
  await button.click();
  const frames = await overlay.evaluate(
    (node) =>
      new Promise((resolve) => {
        const frames = [],
          start = performance.now();
        const sample = () => {
          const shell = node.querySelector(".hive-dock-surface").getBoundingClientRect();
          frames.push({
            time: performance.now() - start,
            width: shell.width,
            height: shell.height,
            phase: node.dataset.phase,
            caps: Array.from(node.querySelectorAll(".hive-dock-button")).map((cap) =>
              Number(getComputedStyle(cap).opacity),
            ),
          });
          if (
            ["expanded", "collapsed"].includes(node.dataset.phase) ||
            performance.now() - start > 3000
          )
            resolve(frames);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  await phase(destination);
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(frames, null, 2));
  assert.ok(
    new Set(frames.map((frame) => Math.round(frame.width))).size > 6,
    "The same shell changes width over visible frames",
  );
  assert.ok(
    new Set(frames.map((frame) => Math.round(frame.height))).size > 6,
    "The shell changes height too",
  );
  await edge();
  return frames;
}
async function drag(handle, x, y) {
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
  await edge();
}

try {
  await page.goto(url);
  await grip.focus();
  await edge();
  assert.equal((await page.getByTestId("workspace-canvas").boundingBox()).height, 900);
  const before = await surface.boundingBox(),
    minimiseBox = await minimise.boundingBox();
  assert.ok(
    minimiseBox.x > before.x + before.width - 34 && minimiseBox.y < before.y + 4,
    "Minimise is in the top-right corner",
  );
  await page.screenshot({ path: resolve(output, "expanded.png") });
  const closing = await morph(minimise, "minimise", "collapsed");
  assert.equal(Math.round(closing.at(-1).width), 48);
  await expect(overlay.getByRole("button")).toHaveCount(1);
  await expect(expand).toBeFocused();
  await expect(dock).toHaveCount(0);
  await page.screenshot({ path: resolve(output, "collapsed.png") });
  const opening = await morph(expand, "expand", "expanded");
  const width = opening.at(-1).width;
  assert.ok(
    opening
      .filter((frame) => frame.width < width - 1)
      .every((frame) => frame.caps.every((opacity) => opacity === 0)),
    "Caps wait for the shell to expand",
  );
  assert.ok(
    opening.some((frame) => frame.caps[0] - frame.caps.at(-1) > 0.15),
    "Caps arrive in a slow stagger",
  );
  await expect(minimise).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dock.getByRole("button", { name: "Apps", exact: true })).toBeFocused();
  checks.push(
    "A top-right minimise control morphs the dock into one 48px expand button; expansion grows the same shell before staggered caps appear. Focus and hidden-control accessibility are preserved.",
  );

  for (const [name, x, y] of [
    ["top", 700, 16],
    ["right", 1430, 450],
    ["bottom", 700, 890],
    ["left", 16, 450],
  ]) {
    await drag(grip, x, y);
    await expect(overlay).toHaveAttribute("data-edge", name);
  }
  await drag(grip, 720, 450);
  await edge();
  await morph(minimise, "minimise-after-drag", "collapsed");
  await drag(expand, 16, 450);
  await phase("collapsed");
  await expect(overlay).toHaveAttribute("data-edge", "left");
  await expand.press("Shift+ArrowRight");
  await edge();
  await expect(overlay).toHaveAttribute("data-edge", "right");
  await expand.press("Home");
  await edge();
  await expand.press("End");
  await edge();
  await expand.press("Enter");
  await phase("expanded");
  await edge();
  await expect(overlay).toHaveAttribute("data-edge", "right");
  const position = await surface.boundingBox(),
    handle = await grip.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await edge();
  await expect
    .poll(async () => Math.abs((await surface.boundingBox()).y - position.y))
    .toBeLessThan(1);
  checks.push(
    "Expanded and collapsed forms drag to all edges; centre drops snap to an edge, drag releases never activate Expand, keyboard arrows/Home/End reposition, and Escape restores a cancelled drag.",
  );

  await page.keyboard.press("Alt+Shift+KeyD");
  await phase("collapsed");
  await expect(expand).toBeFocused();
  await page.keyboard.press("Alt+Shift+KeyD");
  await phase("expanded");
  await expect(dock.getByRole("button", { name: "Apps", exact: true })).toBeFocused();
  await dock.getByRole("button", { name: "Apps", exact: true }).click();
  await page.waitForTimeout(2800);
  await expect(page.getByRole("dialog")).toBeVisible();
  await phase("expanded");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add window", exact: true }).focus();
  await page.mouse.move(720, 450);
  await phase("collapsed");
  await expand.press("Space");
  await phase("expanded");
  await page.mouse.move(720, 450);
  await phase("collapsed");
  checks.push(
    "Alt+Shift+D preserves focus, dialogs hold the dock open, and manual expansion resumes auto-minimise after inactivity.",
  );

  await page.keyboard.press("Alt+Shift+KeyD");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await phase("expanded");
  await expect(page.getByPlaceholder("Search Hive…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await minimise.click();
  await phase("collapsed");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expand.click();
  await phase("expanded");
  await expect
    .poll(
      () =>
        surface.evaluate(
          (node) =>
            node
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === "running").length,
        ),
      { timeout: 300 },
    )
    .toBe(0);
  await minimise.click();
  await phase("collapsed");
  await edge();

  const mobile = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const touch = await mobile.newPage();
  touch.on("pageerror", (error) => errors.push(error.message));
  await touch.goto(url);
  await touch.getByRole("button", { name: "Minimise dock", exact: true }).tap();
  await expect(touch.locator(".hive-dock-overlay")).toHaveAttribute("data-phase", "collapsed");
  const button = await touch
    .getByRole("button", { name: "Expand dock", exact: true })
    .boundingBox();
  const cdp = await mobile.newCDPSession(touch);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: button.x + 24, y: button.y + 24 }],
  });
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 160, y: button.y + 24 + ((20 - button.y - 24) * i) / 10 }],
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await edge(touch);
  await expect(touch.locator(".hive-dock-overlay")).toHaveAttribute("data-phase", "collapsed");
  await expect(touch.locator(".hive-dock-overlay")).toHaveAttribute("data-edge", "top");
  await touch.getByRole("button", { name: "Expand dock", exact: true }).tap();
  await expect(touch.locator(".hive-dock-overlay")).toHaveAttribute("data-phase", "expanded");
  await touch.getByRole("button", { name: "Extra keyboard", exact: true }).tap();
  await expect(touch.locator(".hive-dock")).toHaveAttribute("aria-busy", "false");
  await edge(touch);
  await touch.screenshot({ path: resolve(output, "mobile-top-keyboard.png") });
  const touchGrip = await touch
    .getByRole("button", { name: "Move dock", exact: true })
    .boundingBox();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchGrip.x + touchGrip.width / 2, y: touchGrip.y + touchGrip.height / 2 }],
  });
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 160, y: touchGrip.y + 14 + ((820 - touchGrip.y - 14) * i) / 10 }],
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await edge(touch);
  await touch.getByRole("button", { name: "Minimise dock", exact: true }).tap();
  await expect(touch.locator(".hive-dock-overlay")).toHaveAttribute("data-phase", "collapsed");
  await touch.getByRole("button", { name: "Expand dock", exact: true }).tap();
  await expect(touch.locator(".hive-dock-overlay")).toHaveAttribute("data-phase", "expanded");
  await touch.setViewportSize({ width: 320, height: 480 });
  await edge(touch);
  await expect
    .poll(async () => (await touch.getByTestId("workspace-canvas").boundingBox()).height)
    .toBe(480);
  assert.ok(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.close();
  checks.push(
    "Real touch dragging preserves collapse state and taps still expand; a 320px keyboard dock and resized viewport remain on-screen and edge-attached. Reduced motion is immediate.",
  );
  assert.deepEqual(errors, []);
  const result = { passed: true, checks, browserErrors: errors };
  await writeFile(resolve(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser.close();
}
