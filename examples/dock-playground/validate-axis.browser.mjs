import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/axis");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const overlay = page.locator(".hive-dock-overlay"),
  surface = page.locator(".hive-dock-surface"),
  dock = page.locator(".hive-dock");
const move = page.getByRole("button", { name: "Move dock", exact: true });
const expand = page.getByRole("button", { name: "Expand dock", exact: true });
const minimise = page.getByRole("button", { name: "Minimise dock", exact: true });
const settled = async () => {
  await expect(overlay).toHaveAttribute("data-settling", "false");
  await expect(dock).toHaveAttribute("aria-busy", "false");
};
async function inside() {
  const box = await surface.boundingBox(),
    size = page.viewportSize();
  assert.ok(
    box.x >= 11 &&
      box.y >= 11 &&
      box.x + box.width <= size.width - 11 &&
      box.y + box.height <= size.height - 11,
    JSON.stringify(box),
  );
}
async function orientation(vertical) {
  await settled();
  await inside();
  const caps = await dock
    .locator(".hive-dock-app")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  assert.equal(caps.length, 4);
  for (let i = 1; i < caps.length; i++) {
    assert.ok(Math.abs(caps[i][vertical ? "x" : "y"] - caps[0][vertical ? "x" : "y"]) < 1);
    assert.ok(caps[i][vertical ? "y" : "x"] > caps[i - 1][vertical ? "y" : "x"]);
  }
  const a = await minimise.boundingBox(),
    b = await move.boundingBox(),
    body = await dock.boundingBox();
  if (vertical)
    assert.ok(
      a.x < b.x && Math.abs(a.y - b.y) < 1 && a.y + a.height < body.y,
      "Side dock controls share a row above it",
    );
  else
    assert.ok(
      a.y < b.y && Math.abs(a.x - b.x) < 1 && a.x > body.x + body.width,
      "Horizontal controls share a column to its right",
    );
}
async function sampleMotion(name) {
  const frames = await overlay.evaluate(
    (node) =>
      new Promise((resolve) => {
        const frames = [],
          start = performance.now();
        const step = () => {
          const box = node.getBoundingClientRect();
          frames.push({
            time: performance.now() - start,
            x: box.x,
            y: box.y,
            moving: node.dataset.settling,
            edge: node.dataset.edge,
          });
          if (node.dataset.settling === "false" || performance.now() - start > 1500)
            resolve(frames);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(frames, null, 2));
  return frames;
}
try {
  await page.goto(process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318");
  await move.focus();
  await orientation(false);
  for (const key of ["Left", "Right"]) {
    await move.press(`Shift+Arrow${key}`);
    const rotation = await overlay.evaluate(
      (node) =>
        new Promise((resolve) => {
          const frames = [];
          const step = () => {
            const surface = node.querySelector(".hive-dock-surface"),
              cap = node.querySelector(".hive-dock-button");
            const parent = new DOMMatrix(getComputedStyle(surface).transform),
              own = new DOMMatrix(getComputedStyle(cap).transform);
            const text = parent.multiply(own),
              box = surface.getBoundingClientRect();
            frames.push({
              angle: (Math.atan2(parent.b, parent.a) * 180) / Math.PI,
              text: (Math.atan2(text.b, text.a) * 180) / Math.PI,
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            });
            if (node.dataset.settling === "false") resolve(frames);
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    if (key === "Left")
      assert.ok(
        rotation.some((frame) => Math.abs(frame.angle) > 5 && Math.abs(frame.angle) < 85),
        "The frame visibly rotates between axes",
      );
    assert.ok(
      rotation.every((frame) => Math.abs(frame.text) < 8),
      "Keycap labels remain upright during rotation",
    );
    assert.ok(
      rotation.every(
        (frame) =>
          frame.x >= 11 &&
          frame.y >= 11 &&
          frame.x + frame.width <= 989 &&
          frame.y + frame.height <= 689,
      ),
      "Rotating frame stays inside the viewport",
    );
    await writeFile(
      resolve(output, `rotation-${key.toLowerCase()}.json`),
      JSON.stringify(rotation, null, 2),
    );
    await orientation(true);
    await page.screenshot({ path: resolve(output, `${key.toLowerCase()}-home.png`) });
  }
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await settled();
  const create = dock.getByRole("button", { name: "Create workspace" });
  await create.click();
  const frames = await dock.evaluate(
    (node) =>
      new Promise((resolve) => {
        const frames = [];
        const step = () => {
          frames.push({
            height: node.getBoundingClientRect().height,
            opacity: Number(
              getComputedStyle(node.querySelector("[data-dock-space]:last-child")).opacity,
            ),
          });
          if (node.dataset.spacesChanging === "false") resolve(frames);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  await settled();
  const finalHeight = frames.at(-1).height;
  assert.ok(
    new Set(frames.map((frame) => Math.round(frame.height))).size > 6,
    "Vertical creation allocates height across frames",
  );
  assert.ok(
    frames.filter((frame) => frame.height < finalHeight - 1).every((frame) => frame.opacity === 0),
    "New space waits for vertical allocation",
  );
  await writeFile(resolve(output, "vertical-create.json"), JSON.stringify(frames, null, 2));
  while ((await dock.locator("[data-dock-space]").count()) < 9) {
    await create.click();
    await settled();
  }
  await expect(dock.getByRole("button", { name: "Scroll spaces down" })).toBeVisible();
  const selected = dock.locator(".hive-dock-workspace[aria-current='page']");
  await expect(selected).toBeInViewport();
  assert.ok(await dock.locator(".hive-dock-options").evaluate((node) => node.scrollTop > 0));
  await inside();
  await page.screenshot({ path: resolve(output, "vertical-spaces.png") });
  await dock.getByRole("button", { name: "Remove workspace 9", exact: true }).click();
  await settled();
  await expect(
    dock.getByRole("button", { name: "Workspace 1: Workspace 1", exact: true }),
  ).toBeFocused();
  await expect(dock.locator("[data-dock-space]")).toHaveCount(8);
  await dock.getByRole("button", { name: "Back to main dock" }).click();
  await settled();
  await dock.getByRole("button", { name: "Extra keyboard", exact: true }).click();
  await settled();
  const options = dock.locator(".hive-dock-options");
  await expect(dock.getByRole("button", { name: "Scroll keys down" })).toBeVisible();
  await dock.getByRole("button", { name: "Back to main dock" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(dock.getByRole("button", { name: "Ctrl modifier", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dock.getByRole("button", { name: "Ctrl modifier", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dock.getByRole("button", { name: "Scroll keys down" }).click();
  await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(20);
  const prior = await options.evaluate((node) => node.scrollTop);
  await options.hover();
  await page.mouse.wheel(0, 100);
  await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(prior);
  await page.screenshot({ path: resolve(output, "vertical-keys.png") });
  const dragBox = await move.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(14, 350, { steps: 10 });
  await page.mouse.up();
  await settled();
  await expect(overlay).toHaveAttribute("data-edge", "left");
  await expect(dock).toHaveAttribute("data-orientation", "vertical");
  await minimise.click();
  await expect(overlay).toHaveAttribute("data-phase", "collapsed");
  await expand.click();
  await expect(overlay).toHaveAttribute("data-phase", "expanded");
  await expect(dock).toHaveAttribute("data-view", "keyboard");
  await expect(dock.getByRole("button", { name: "Ctrl modifier", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await move.press("Shift+ArrowUp");
  await settled();
  await expect(dock.getByRole("button", { name: "Scroll keys right" })).toBeVisible();
  await dock.getByRole("button", { name: "Back to main dock" }).click();
  await settled();
  await orientation(false);
  checks.push(
    "Left/right docks stack upright caps with controls above; top/bottom docks use a row with controls in a centred right column. Vertical spaces animate height, scroll/reveal/remove correctly, and keys support Up/Down focus, wheel/arrow scrolling, and state-preserving morphs.",
  );

  await minimise.click();
  await expect(overlay).toHaveAttribute("data-phase", "collapsed");
  await expand.press("Shift+ArrowUp");
  await settled();
  let box = await expand.boundingBox();
  await page.mouse.move(box.x + 23, box.y + 23);
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 10 });
  await page.waitForTimeout(120);
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(300 + 12 * i, 300);
    await page.waitForTimeout(16);
  }
  const release = await surface.boundingBox();
  await page.mouse.up();
  const momentum = await sampleMotion("inertia");
  const coasting = momentum.filter((frame) => frame.time < 160);
  assert.ok(
    coasting.length > 4 && coasting.at(-1).x > release.x + 15,
    "Release preserves horizontal velocity before edge attraction",
  );
  const speeds = momentum.slice(1).map((frame, i) => ({
    time: frame.time,
    speed:
      Math.hypot(frame.x - momentum[i].x, frame.y - momentum[i].y) /
      Math.max(1, frame.time - momentum[i].time),
  }));
  const peak = speeds.findIndex(
    (frame) => frame.speed === Math.max(...speeds.map((entry) => entry.speed)),
  );
  const tail = speeds.slice(peak + 2).filter((frame) => frame.speed > 0.015);
  assert.ok(
    tail.every((frame, i) => i === 0 || frame.speed <= tail[i - 1].speed * 1.3 + 0.01),
    "The spring slows continuously after its velocity peak, without a second snap acceleration",
  );
  await settled();
  await inside();
  assert.equal(await overlay.getAttribute("data-edge"), "top");
  assert.ok(momentum.at(-1).time < 1250, "The damped spring settles promptly");
  checks.push(
    "Release velocity feeds one damped spring, with no separate coast/snap handoff or second acceleration.",
  );

  for (const gentle of [true, false]) {
    await expand.press("Shift+ArrowLeft");
    await settled();
    const start = await expand.boundingBox();
    await page.mouse.move(start.x + 23, start.y + 23);
    await page.mouse.down();
    if (gentle) {
      for (let i = 1; i <= 14; i++) {
        await page.mouse.move(start.x + 23 + ((250 - start.x - 23) * i) / 14, 350);
        await page.waitForTimeout(40);
      }
    } else await page.mouse.move(250, 350, { steps: 3 });
    await page.mouse.up();
    const trace = await sampleMotion(gentle ? "gentle-return" : "strong-flick");
    await settled();
    await inside();
    await expect(overlay).toHaveAttribute("data-edge", gentle ? "left" : "right");
    if (gentle)
      assert.ok(
        Math.max(...trace.map((frame) => frame.x)) < 400,
        "A gentle release returns locally instead of crossing the screen",
      );
  }
  checks.push(
    "At the same release position, a gentle drag returns to the near edge while a strong flick carries to the opposite edge.",
  );

  box = await expand.boundingBox();
  await page.mouse.move(box.x + 23, box.y + 23);
  await page.mouse.down();
  await page.mouse.move(500, 400, { steps: 6 });
  await page.mouse.up();
  await expect(overlay).toHaveAttribute("data-settling", "true");
  // Catch it while still moving, after the initial high-speed part of the flick.
  await page.waitForTimeout(300);
  box = await expand.boundingBox();
  await page.mouse.move(box.x + 23, box.y + 23);
  await page.mouse.down();
  await expect(overlay).toHaveAttribute("data-dragging", "true");
  await expect(overlay).toHaveAttribute("data-settling", "false");
  await page.mouse.move(20, 300, { steps: 8 });
  await page.mouse.up();
  await settled();
  await inside();
  await page.emulateMedia({ reducedMotion: "reduce" });
  box = await expand.boundingBox();
  await page.mouse.move(box.x + 23, box.y + 23);
  await page.mouse.down();
  await page.mouse.move(800, 450, { steps: 5 });
  await page.mouse.up();
  // Read after the release event has reached its first painted frame.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(overlay).toHaveAttribute("data-settling", "false");
  await inside();
  const reducedPosition = await surface.boundingBox();
  await page.waitForTimeout(150);
  assert.deepEqual(await surface.boundingBox(), reducedPosition);
  checks.push(
    "A new drag interrupts momentum; reduced-motion releases attach immediately without coasting.",
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
