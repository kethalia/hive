import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

if (process.env.HIVE_WORKSPACE_PROFILE !== "browser") throw Error("Browser Testing required");
const { chromium } = await import(process.env.HIVE_PLAYWRIGHT_MODULE ?? "@playwright/test");
const directory = resolve(process.argv[2]);
const evidence = resolve(directory, "evidence");
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  const file =
    req.url === "/bundle.js" ? "bundle.js" : req.url === "/style.css" ? "style.css" : "index.html";
  res.setHeader(
    "Content-Type",
    file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
  );
  res.end(await readFile(resolve(directory, file)));
});
const apps = createServer((_req, res) => res.end("<p>Project application</p>"));
await new Promise((done) => server.listen(8831, "127.0.0.1", done));
await new Promise((done) => apps.listen(8832, "127.0.0.1", done));
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = { checks: [], errors: [] };
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    await page.getByLabel("codex input").waitFor();
    const search = async (query) => {
      await page.keyboard.press("Control+k");
      await page.locator("[cmdk-input]").fill(query);
    };
    const open = async (tool) => {
      await search(tool);
      await page.locator(`[data-action-id="dashboard:open-${tool}"]`).click();
    };
    await open("templates");
    const templates = page.getByTestId("hive-window-templates");
    const scroll = templates.getByTestId("templates-scroll-region");
    await scroll.waitFor();
    const selector = templates.getByRole("combobox", { name: "Template", exact: true });
    const triggerBounds = await selector.boundingBox();
    const pushBounds = await templates
      .getByRole("button", { name: "Push all", exact: true })
      .boundingBox();
    assert(triggerBounds.width <= 200);
    assert(triggerBounds.x + triggerBounds.width <= pushBounds.x);
    assert.equal(await templates.getByText("Template", { exact: true }).count(), 0);
    assert.equal(await templates.locator("select").count(), 0);
    const chevron = await selector.locator("svg").boundingBox();
    assert(
      Math.abs(chevron.y + chevron.height / 2 - triggerBounds.y - triggerBounds.height / 2) < 2,
    );
    assert(triggerBounds.x + triggerBounds.width - chevron.x - chevron.width >= 10);
    await selector.click();
    await page.getByRole("listbox").waitFor();
    await page.waitForFunction(() => {
      const popup = document.querySelector('[data-slot="select-content"]');
      return popup && getComputedStyle(popup).opacity === "1";
    });
    await page.screenshot({ path: resolve(evidence, `template-select-${width}.png`) });
    await page.getByRole("option", { name: "All templates", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await templates.getByText("Template Details", { exact: true }).waitFor();
    const assertTemplateFocus = async () => {
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await selector.evaluate((el) => el === document.activeElement), true);
    };
    await assertTemplateFocus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await templates.getByRole("heading", { name: "game-dev", exact: true }).waitFor();
    await assertTemplateFocus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await scroll.waitFor();
    await assertTemplateFocus();
    report.checks.push(
      `${width}: compact themed Template selector precedes Push all and opens details/list`,
    );
    report.checks.push(`${width}: keyboard focus survives list/detail and keyed template changes`);
    for (const mode of width === 1440 ? ["grid", "strip"] : ["grid"]) {
      if (mode === "strip") await page.getByRole("button", { name: "Strip layout" }).click();
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      await scroll.hover();
      await page.mouse.wheel(0, 2500);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="templates-scroll-region"]').scrollTop > 100,
      );
      const bounds = await scroll.evaluate((el) => ({
        height: el.clientHeight,
        content: el.scrollHeight,
      }));
      assert(bounds.height > 100 && bounds.height < 800 && bounds.content > bounds.height);
      report.checks.push(
        `${width}/${mode}: Templates wheel scrolling reaches below the first card`,
      );
    }
    await page.screenshot({ path: resolve(evidence, `templates-${width}.png`) });
    await open("workspaces");
    const management = page.getByTestId("hive-window-workspaces");
    await management.getByTestId("open-create-workspace-screen").click();
    const creation = management.getByTestId("create-workspace-screen");
    await creation.waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await management.getByTestId("workspaces-card-grid").count(), 0);
    await creation.getByLabel("Workspace name").fill("project-helper");
    await creation.getByRole("combobox", { name: "Workspace profile" }).click();
    await page.getByRole("listbox").waitFor();
    await page.waitForFunction(() => {
      const popup = document.querySelector('[data-slot="select-content"]');
      return popup && getComputedStyle(popup).opacity === "1";
    });
    await page.screenshot({ path: resolve(evidence, `profile-select-${width}.png`) });
    await page.getByRole("option", { name: "browser-testing", exact: true }).click();
    await creation.getByRole("button", { name: "Back to workspaces" }).click();
    await management.getByTestId("workspace-card").first().waitFor();
    await management.getByTestId("open-create-workspace-screen").click();
    assert.equal(await creation.getByLabel("Workspace name").inputValue(), "project-helper");
    await page.screenshot({ path: resolve(evidence, `launch-${width}.png`) });
    await creation.getByTestId("submit-create-workspace").click();
    await management.getByTestId("workspace-card").first().waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.createdWorkspace), {
      templateId: "browser-testing",
      name: "project-helper",
    });
    report.checks.push(
      `${width}: launch, back, preserved draft, submit and return to management without a dialog`,
    );
    for (const [tool, title] of [
      ["files", "Files"],
      ["code", "VS Code"],
    ]) {
      await search(`${title} hive`);
      assert.equal(await page.locator('[data-slot="command-shortcut"]').count(), 0);
      await page
        .locator(`[data-action-id="project-app:software:${tool}:git-clone:projects/kethalia/hive"]`)
        .click();
      await page.waitForFunction(
        (expected) =>
          window.fixture.lastAppRequest?.projectPath === "projects/kethalia/hive" &&
          window.fixture.lastAppRequest.tool === expected,
        tool === "files" ? "filebrowser" : "code",
      );
      const count = await page.locator(`[data-testid="general-app-${tool}"]`).count();
      await search(`${title} hive`);
      await page
        .locator(`[data-action-id="project-app:software:${tool}:git-clone:projects/kethalia/hive"]`)
        .click();
      assert.equal(await page.locator(`[data-testid="general-app-${tool}"]`).count(), count);
      report.checks.push(`${width}: ${title} project entry opens and reuses its own window`);
    }
    await search("logs hive");
    await page
      .locator('[data-action-id="project-logs:software:git-clone:projects/kethalia/hive"]')
      .click();
    await page
      .getByTestId("hive-window-logs")
      .getByText("session=git-clone-fixture", { exact: true })
      .waitFor();
    report.checks.push(`${width}: project Logs filters by the repository terminal`);
    await open("agents");
    const agents = page.getByTestId("hive-window-agents");
    const agentSelect = agents.getByRole("combobox", { name: "Agent workspace" });
    await agentSelect.click();
    await page.getByRole("option", { name: "infrastructure-helper · stopped" }).click();
    await agents.getByText("Start a Coder workspace to view its agent conversations.").waitFor();
    await agentSelect.click();
    await page.getByRole("option", { name: "ai-dev-01 · running" }).click();
    await agents.getByRole("heading", { name: "Recent conversations" }).waitFor();
    report.checks.push(`${width}: themed Agent workspace picker switches stopped/running targets`);
    await page.keyboard.press("Control+Shift+Slash");
    const help = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
    const shortcuts = help.getByRole("combobox", { name: "Layout shortcuts" });
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return (
        dialog &&
        !dialog.hasAttribute("data-starting-style") &&
        getComputedStyle(dialog).opacity === "1"
      );
    });
    await shortcuts.click();
    await page.getByRole("option", { name: "Off — use buttons and search" }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="Layout shortcuts"]')?.textContent.includes("Off"),
    );
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.match(await shortcuts.textContent(), /Off/);
    assert.equal(await help.getByText("Focus window left", { exact: true }).count(), 0);
    await shortcuts.click();
    await page.getByRole("option", { name: "On — platform shortcuts" }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await help.getByText("Focus window left", { exact: true }).waitFor();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    await shortcuts.click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.equal(await help.count(), 1);
    assert.equal(await shortcuts.evaluate((el) => el === document.activeElement), true);
    report.checks.push(
      `${width}: keyboard selection and Escape restore focus inside shortcut help`,
    );
    await context.close();
  }
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 480 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await mobile.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://127.0.0.1:8831");
  await page.getByLabel("codex input").waitFor();
  await page.keyboard.press("Control+k");
  await page.locator("[cmdk-input]").fill("workspaces");
  await page.locator('[data-action-id="dashboard:open-workspaces"]').click();
  await page.getByTestId("open-create-workspace-screen").click();
  await page.getByRole("combobox", { name: "Workspace profile" }).tap();
  const options = page.locator('[data-slot="select-content"]');
  await options.waitFor();
  const overflow = await options.evaluate((el) => ({
    height: el.clientHeight,
    content: el.scrollHeight,
  }));
  assert(
    overflow.content > overflow.height,
    "Profile options must overflow for the scroll regression",
  );
  const touchAllowed = await options.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const touch = new Touch({
      identifier: 1,
      target: el,
      clientX: rect.x + 20,
      clientY: rect.y + 20,
    });
    const event = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      changedTouches: [touch],
      targetTouches: [touch],
    });
    el.dispatchEvent(event);
    return !event.defaultPrevented;
  });
  assert(touchAllowed, "The mobile shell must allow touch scrolling in portaled select menus");
  const cdp = await mobile.newCDPSession(page);
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('[data-slot="select-content"]')).opacity === "1",
  );
  const bounds = await options.boundingBox();
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 30 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x, y: point.y - step * 20 }],
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert(await options.evaluate((el) => el.scrollTop > 0), "A touch swipe must scroll the options");
  await options.evaluate((el) => {
    el.scrollTop = 0;
  });
  await options.hover();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(
    () => document.querySelector('[data-slot="select-content"]')?.scrollTop > 0,
  );
  await page.getByRole("option", { name: "infrastructure", exact: true }).tap();
  assert.match(
    await page.getByRole("combobox", { name: "Workspace profile" }).textContent(),
    /infrastructure/,
  );
  report.checks.push(
    "390×480: overflowing profile menu accepts touch swipes and wheel scrolling; last option is selectable",
  );
  await mobile.close();
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(resolve(evidence, "workspace-tools.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
  apps.close();
}
console.log(JSON.stringify(report, null, 2));
