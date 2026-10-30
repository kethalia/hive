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
const failures = [];
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on("pageerror", (error) => failures.push(error.message));
  const response = await page.goto(process.env.DOCK_PREVIEW_URL ?? "http://127.0.0.1:4318");
  assert.equal(response.status(), 200);
  const dock = page.getByRole("navigation", { name: "Workspace dock" });
  await expect(dock.getByRole("button")).toHaveCount(4);
  await page.screenshot({ path: resolve(output, "desktop-home.png"), fullPage: true });
  checks.push("Desktop home: four app-style dock controls render without app integration.");

  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeFocused();
  await expect(dock.getByRole("button", { name: "Apps", exact: true })).toHaveCount(0);
  await dock.getByRole("button", { name: "Create workspace" }).click();
  await expect(dock.getByRole("button", { name: "Workspace 4: Workspace 4" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const input = page.getByRole("textbox", { name: "Simulated terminal input" });
  await input.fill("echo fourth-workspace");
  await input.press("Enter");
  await expect(page.getByRole("region", { name: "Simulated terminal output" })).toContainText(
    "fourth-workspace",
  );
  await dock.getByRole("button", { name: "Workspace 1: Main workspace" }).click();
  await expect(page.getByRole("region", { name: "Simulated terminal output" })).not.toContainText(
    "fourth-workspace",
  );
  await dock.getByRole("button", { name: "Workspace 4: Workspace 4" }).click();
  await expect(page.getByRole("region", { name: "Simulated terminal output" })).toContainText(
    "fourth-workspace",
  );
  await page.screenshot({ path: resolve(output, "desktop-workspaces.png"), fullPage: true });
  await dock.getByRole("button", { name: "Back to main dock" }).press("Escape");
  await expect(dock.getByRole("button", { name: "Workspaces", exact: true })).toBeFocused();
  checks.push(
    "Workspaces replace home controls; + creates and selects; numbered switches retain independent sessions; Escape restores opener focus.",
  );

  await dock.getByRole("button", { name: "Extra keyboard" }).click();
  await dock.getByRole("button", { name: "Ctrl modifier" }).click();
  await dock.getByRole("button", { name: "Shift modifier" }).click();
  await dock.getByRole("button", { name: "Ctrl+Shift+Up", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Ctrl+Shift+Up");
  await expect(page.getByRole("status")).toContainText("1;6A");
  await expect(dock.getByRole("button", { name: "Ctrl modifier" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(dock.getByRole("button", { name: "Shift modifier" })).toHaveAttribute(
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
  ]) {
    await expect(dock.getByRole("button", { name, exact: true })).toHaveCount(1);
  }
  await input.fill("copy me");
  await dock.getByRole("button", { name: "Copy terminal selection", exact: true }).click();
  await input.fill("");
  await dock.getByRole("button", { name: "Paste from clipboard", exact: true }).click();
  await expect(input).toHaveValue("copy me");
  const fontBefore = await page
    .locator(".terminal-body")
    .evaluate((node) => getComputedStyle(node).fontSize);
  await dock.getByRole("button", { name: "Increase font size", exact: true }).click();
  assert.notEqual(
    await page.locator(".terminal-body").evaluate((node) => getComputedStyle(node).fontSize),
    fontBefore,
  );
  const chooserPromise = page.waitForEvent("filechooser");
  await dock.getByRole("button", { name: "Upload files", exact: true }).click();
  await (await chooserPromise).setFiles({
    name: "dock-demo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("local demo"),
  });
  await expect(page.getByRole("status")).toContainText("dock-demo.txt");
  await page.screenshot({ path: resolve(output, "desktop-keyboard.png"), fullPage: true });
  checks.push(
    "Full mobile key inventory available on desktop; encoded modifier combinations reset after use; local clipboard, file picker, and font controls work.",
  );

  await dock.getByRole("button", { name: "Back to main dock" }).click();
  await dock.getByRole("button", { name: "Apps", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Files Everything in its place" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Your files, at a glance.")).toBeVisible();
  await dock.getByRole("button", { name: "Keybinds", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("A few helpful keybinds.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await dock.getByRole("button", { name: "Apps", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dock.getByRole("button", { name: "Workspaces", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(dock.getByRole("button", { name: "Keybinds", exact: true })).toBeFocused();
  checks.push(
    "App launcher changes preview app; keybind dialog opens and closes with Escape; arrow/End navigation moves dock focus.",
  );

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.getByRole("button", { name: "moss backdrop" }).click();
  await page.getByRole("combobox", { name: "Dock size" }).selectOption("compact");
  await page.screenshot({ path: resolve(output, "light-compact.png"), fullPage: true });
  await expect(dock).toHaveAttribute("data-density", "compact");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  await expect(dock.getByRole("button")).toHaveCount(5);
  await dock.getByRole("button", { name: "Back to main dock" }).click();
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  checks.push("Theme, backdrop, density, and session reset controls work.");

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Mobile preview" }).click();
    await expect(dock.getByRole("button")).toHaveCount(4);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `No page overflow at ${width}px`,
    );
    await page.screenshot({ path: resolve(output, `mobile-${width}-home.png`), fullPage: true });
    await dock.getByRole("button", { name: "Extra keyboard" }).click();
    await dock.getByRole("button", { name: "Upload files", exact: true }).scrollIntoViewIfNeeded();
    await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeInViewport();
    await expect(dock.getByRole("button", { name: "Upload files", exact: true })).toBeInViewport();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: resolve(output, `mobile-${width}-keyboard.png`),
      fullPage: true,
    });
    await dock.getByRole("button", { name: "Back to main dock" }).click();
    await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
    for (let i = 0; i < 12; i++)
      await dock.getByRole("button", { name: "Create workspace" }).click();
    await dock.getByRole("button", { name: "Workspace 15: Workspace 15" }).scrollIntoViewIfNeeded();
    await expect(dock.getByRole("button", { name: "Back to main dock" })).toBeInViewport();
    await page.screenshot({
      path: resolve(output, `mobile-${width}-workspaces.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    checks.push(
      `${width}px: no page overflow; keyboard scroll reaches upload while Back stays visible; 15 workspaces remain reachable.`,
    );
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dock.getByRole("button", { name: "Workspaces", exact: true }).click();
  assert.equal(
    await page
      .locator(".hive-dock-options")
      .evaluate((node) => getComputedStyle(node).animationName),
    "none",
  );
  checks.push("Reduced motion removes dock entrance animation.");
  assert.deepEqual(failures, [], "No browser exceptions");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify({ passed: true, checks, browserErrors: failures }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks, browserErrors: failures }, null, 2));
} finally {
  await browser.close();
}
