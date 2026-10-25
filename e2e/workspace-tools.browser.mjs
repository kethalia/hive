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
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto("http://127.0.0.1:8831");
    await page.getByLabel("codex input").waitFor();
    const search = async (query) => {
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").fill(query);
    };
    const open = async (tool) => {
      await search(tool);
      await page.locator(`[data-action-id="dashboard:open-${tool}"]`).click();
    };
    await open("templates");
    const templates = page.getByTestId("hive-window-templates");
    const scroll = templates.getByTestId("templates-scroll-region");
    await scroll.waitFor();
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
    await creation.getByLabel("Workspace profile").selectOption("browser-testing");
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
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(resolve(evidence, "workspace-tools.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
  apps.close();
}
console.log(JSON.stringify(report, null, 2));
