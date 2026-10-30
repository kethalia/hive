import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve(process.env.DOCK_EVIDENCE_DIR ?? "/tmp/hive-dock-validation/spaces");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const dock = page.getByRole("navigation", { name: "Workspace dock" });
const create = dock.getByRole("button", { name: "Create workspace" });
const idle = () => expect(dock).toHaveAttribute("aria-busy", "false");
async function sample(name) {
  const frames = await dock.evaluate(
    (node) =>
      new Promise((resolve) => {
        const frames = [],
          start = performance.now();
        const frame = () => {
          frames.push({
            time: Math.round(performance.now() - start),
            width: node.getBoundingClientRect().width,
            spaces: Array.from(node.querySelectorAll("[data-dock-space]")).map((item) => ({
              id: item.dataset.dockSpace,
              opacity: Number(getComputedStyle(item).opacity),
              x: new DOMMatrix(getComputedStyle(item).transform).m41,
            })),
          });
          if (node.dataset.spacesChanging !== "true" || performance.now() - start > 2500)
            resolve(frames);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  await idle();
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(frames, null, 2));
  return frames;
}
try {
  await page.goto(process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, "screen-and-dock.png") });
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await idle();
  await create.click();
  await expect(dock).toHaveAttribute("data-spaces-changing", "true");
  const added = await sample("create-space");
  assert.ok(added.length > 8);
  assert.ok(
    added.some((frame) => frame.spaces.some((space) => space.opacity > 0 && space.opacity < 1)),
    "New cap fades into the row",
  );
  assert.ok(
    new Set(added.map((frame) => Math.round(frame.width))).size > 6,
    "Tray grows over multiple frames",
  );
  await create.click();
  await idle();
  await dock.getByRole("button", { name: "Workspace 2: Workspace 2", exact: true }).click();
  const removedId = await dock.locator(".hive-dock-space").nth(1).getAttribute("data-dock-space");
  const survivorId = await dock.locator(".hive-dock-space").nth(2).getAttribute("data-dock-space");
  await dock.getByRole("button", { name: "Remove workspace 2", exact: true }).click();
  await expect(dock).toHaveAttribute("data-spaces-changing", "true");
  const removed = await sample("remove-space");
  assert.ok(
    removed.some((frame) =>
      frame.spaces.some(
        (space) => space.id === removedId && space.opacity > 0 && space.opacity < 1,
      ),
    ),
    "Removed cap exits before unmounting",
  );
  assert.ok(
    removed.some((frame) =>
      frame.spaces.some((space) => space.id === survivorId && Math.abs(space.x) > 1),
    ),
    "Survivors slide into the gap",
  );
  await expect(dock.locator(".hive-dock-space")).toHaveCount(2);
  await expect(
    dock.getByRole("button", { name: "Workspace 1: Workspace 1", exact: true }),
  ).toBeFocused();
  checks.push(
    "Adding a cap fades/scales it into an expanding tray; removing a middle cap animates its exit and the survivors' positions before restoring focus.",
  );

  await create.click();
  await page.keyboard.press("Escape");
  await expect(dock).toHaveAttribute("data-view", "home");
  await idle();
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await idle();
  await page.setViewportSize({ width: 320, height: 844 });
  while ((await dock.locator(".hive-dock-space").count()) < 9) {
    await create.click();
    await idle();
  }
  await expect(
    dock.getByRole("button", { name: "Workspace 9: Workspace 9", exact: true }),
  ).toBeInViewport();
  await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeInViewport();
  await expect(create).toBeInViewport();
  await dock.getByRole("button", { name: "Remove workspace 9", exact: true }).click();
  await sample("mobile-remove");
  await expect(dock.locator(".hive-dock-space")).toHaveCount(8);
  await expect(
    dock.getByRole("button", { name: "Workspace 1: Workspace 1", exact: true }),
  ).toBeInViewport();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(output, "mobile-spaces.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await create.click();
  await idle();
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
    "Back queues safely during cap animation; mobile creation/removal retains pinned controls and selected-cap visibility; reduced-motion mutations finish immediately.",
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
