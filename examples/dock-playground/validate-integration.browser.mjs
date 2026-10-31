import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/integration");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const errors = [],
  checks = [];
const base = process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318";
async function checkPage(page, mobile) {
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?integration=1`);
  const dock = page.locator(".hive-dock");
  const overlay = page.locator(".hive-dock-overlay");
  const ready = () => expect(dock).toHaveAttribute("aria-busy", "false");
  const home = async () => {
    const back = dock.getByRole("button", { name: "Back to main dock" });
    if (await back.count()) {
      await back.click();
      await ready();
    }
  };
  const launch = async (name) => {
    await home();
    await dock.getByRole("button", { name: "Apps", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByPlaceholder("Search Hive…").fill(name);
    await page
      .getByRole("option", { name: new RegExp(name, "i") })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  await dock.getByRole("button", { name: "Extra keyboard", exact: true }).click();
  await ready();
  await expect(dock.getByRole("button", { name: "Ctrl modifier" })).toBeDisabled();
  await launch("Terminal");
  const input = page.locator(".xterm-helper-textarea");
  await expect(input).toHaveCount(1);
  await launch("Toggle full width");
  const frame = page.locator('[data-pane-mode][data-testid^="preview-window-"]:visible');
  const screen = page.viewportSize();
  await expect
    .poll(async () => {
      const r = await frame.boundingBox();
      return [r.x, r.y, screen.width - r.x - r.width, screen.height - r.y - r.height].map(
        Math.round,
      );
    })
    .toEqual([4, 4, 4, 4]);
  await page.screenshot({
    path: resolve(output, `${mobile ? "mobile" : "desktop"}-full-window.png`),
  });
  await launch("Files");
  await launch("Use Grid layout");
  const frames = page.locator('[data-pane-mode][data-testid^="preview-window-"]:visible');
  await expect(frames).toHaveCount(2);
  await expect
    .poll(async () => {
      const rects = await frames.evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().toJSON()),
      );
      return Math.round(
        Math.max(
          rects[1].x - rects[0].right,
          rects[0].x - rects[1].right,
          rects[1].y - rects[0].bottom,
          rects[0].y - rects[1].bottom,
        ),
      );
    })
    .toBe(4);
  await page.screenshot({ path: resolve(output, `${mobile ? "mobile" : "desktop"}-grid.png`) });
  await page.locator("[data-sandbox-terminal]").click();
  await expect(input).toBeFocused();
  const keys = dock.getByRole("button", { name: "Extra keyboard", exact: true });
  if (mobile) await keys.tap();
  else await keys.click();
  await ready();
  await expect(input).toBeFocused();
  const ctrl = dock.getByRole("button", { name: "Ctrl modifier" });
  if (mobile) await ctrl.tap();
  else await ctrl.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  await expect(input).toBeFocused();
  await page.keyboard.type("c");
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  if (mobile) await page.waitForTimeout(1700);
  const alt = dock.getByRole("button", { name: "Alt modifier" });
  if (mobile) await alt.tap();
  else await alt.click();
  await expect(alt).toHaveAttribute("aria-pressed", "true");
  if (mobile) {
    await page.waitForTimeout(1700);
    await expect(overlay).toHaveAttribute("data-phase", "expanded");
  }
  const enter = dock.getByRole("button", { name: "Alt+Enter", exact: true });
  if (mobile) await enter.tap();
  else await enter.click();
  await expect(alt).toHaveAttribute("aria-pressed", "false");
  await expect(input).toBeFocused();
  // The PWA shell cancels page gestures; the marked dock strip must remain scrollable.
  const options = dock.locator(".hive-dock-options");
  if (await options.evaluate((n) => n.scrollWidth > n.clientWidth + 1)) {
    await options.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => options.evaluate((n) => n.scrollLeft)).toBeGreaterThan(100);
  }
  if (mobile) {
    await page.mouse.move(screen.width / 2, screen.height / 2);
    await options.evaluate((node) => {
      node.scrollLeft = 0;
    });
    const rect = await options.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: rect.x + rect.width - 20, y: rect.y + rect.height / 2 }],
    });
    for (let i = 1; i <= 8; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: rect.x + rect.width - 20 - ((rect.width - 40) * i) / 8,
            y: rect.y + rect.height / 2,
          },
        ],
      });
    await page.waitForTimeout(2800);
    await expect(overlay).toHaveAttribute("data-phase", "expanded");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => options.evaluate((n) => n.scrollLeft)).toBeGreaterThan(50);
    await cdp.detach();
  }
  await dock.getByRole("button", { name: "Increase font size" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          (k) => k.startsWith("terminal:font-size:") && localStorage.getItem(k) === "14",
        ),
      ),
    )
    .toBe(true);
  await home();
  await dock.getByRole("button", { name: "Keybinds", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(help).toBeVisible();
  await expect(help.getByText("Layout shortcuts", { exact: true })).toBeVisible();
  await page.mouse.move(screen.width / 2, screen.height / 2);
  await page.waitForTimeout(2800);
  await expect(overlay).toHaveAttribute("data-phase", "expanded");
  await page.keyboard.press("Alt+Shift+KeyD");
  await expect(help).toBeVisible();
  await expect(overlay).toHaveAttribute("data-phase", "expanded");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Keybinds", exact: true })).toBeFocused();
  await input.focus();
  await page.mouse.move(screen.width / 2, screen.height / 2);
  await expect(overlay).toHaveAttribute("data-phase", "collapsed");
  await page.keyboard.press("Alt+Shift+KeyD");
  await expect(overlay).toHaveAttribute("data-phase", "expanded");
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await ready();
  await dock.getByRole("button", { name: "Create workspace" }).click();
  await ready();
  await expect(page.locator("[data-sandbox-terminal]:visible")).toHaveCount(0);
  await dock.getByRole("button", { name: "Remove workspace 2" }).click();
  await ready();
  await expect(page.locator("[data-sandbox-terminal]:visible")).toHaveCount(1);
  await home();
  if (mobile) {
    const move = page.getByRole("button", { name: "Move dock", exact: true });
    await move.press("Shift+ArrowLeft");
    await expect(overlay).toHaveAttribute("data-settling", "false");
    await dock.getByRole("button", { name: "Extra keyboard", exact: true }).tap();
    await ready();
    await options.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => options.evaluate((n) => n.scrollTop)).toBeGreaterThan(100);
    await page.setViewportSize({ width: 320, height: 480 });
    await expect
      .poll(async () => {
        const b = await page.locator(".hive-dock-surface").boundingBox();
        return b.y + b.height;
      })
      .toBeLessThanOrEqual(469);
    await page.screenshot({ path: resolve(output, "mobile-side-keys-resized.png") });
  }
  checks.push(
    `${mobile ? "Mobile PWA shell" : "Desktop"}: matching 4px outer/grid gaps and full-width padding; native xterm focus and one-shot modifiers; font actions, dock scrolling, live help/dialog holds, and workspace lifecycle pass.`,
  );
}
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await checkPage(desktop, false);
  await desktop.close();
  const mobile = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await checkPage(await mobile.newPage(), true);
  await mobile.close();
  assert.deepEqual(errors, []);
  const result = { passed: true, checks, browserErrors: errors };
  await writeFile(resolve(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages())
      await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
