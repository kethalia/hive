import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const { chromium } = await import(process.env.HIVE_PLAYWRIGHT_MODULE ?? "@playwright/test");
if (process.env.HIVE_WORKSPACE_PROFILE !== "browser")
  throw new Error("Run browser validation in Browser Testing.");
const directory = resolve(process.argv[2] ?? ".artifacts/window-management/browser");
const evidence = resolve(directory, "evidence");
await mkdir(evidence, { recursive: true });
const app = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><body style="background:#101c14;color:#bddec6;font:16px monospace;padding:24px"><h2>Files</h2><p>kethalia / hive</p><textarea aria-label="File draft">Unsent app draft</textarea>',
  );
});
const server = createServer(async (req, res) => {
  try {
    const file =
      req.url === "/bundle.js"
        ? "bundle.js"
        : req.url === "/style.css"
          ? "style.css"
          : "index.html";
    res.setHeader(
      "Content-Type",
      file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html",
    );
    res.end(await readFile(resolve(directory, file)));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise((done) => app.listen(8832, "127.0.0.1", done));
await new Promise((done) => server.listen(8831, "127.0.0.1", done));
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = { checks: [], errors: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://127.0.0.1:8831");
  await page.getByLabel("codex input").waitFor();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox");
  const options = page.getByRole("option");
  async function check(query, first, ids) {
    await search.fill(query);
    await page.waitForTimeout(150);
    const actual = await options.evaluateAll((items) => items.map((item) => item.dataset.actionId));
    assert.equal(actual[0], first, `${query}: ${JSON.stringify(actual)}`);
    if (ids) assert.deepEqual(actual, ids, query);
    assert.equal(
      await page.locator('[cmdk-item][aria-selected="true"]').getAttribute("data-action-id"),
      first,
      `selected: ${query}`,
    );
    report.checks.push(`${query || "empty search"}: best result first and selected`);
  }
  await check("settings", "dashboard:open-settings", ["dashboard:open-settings"]);
  await page.screenshot({ path: resolve(evidence, "settings.png") });
  await check("settigns", "dashboard:open-settings", ["dashboard:open-settings"]);
  await check("preferences", "dashboard:open-settings", ["dashboard:open-settings"]);
  await page.keyboard.press("Enter");
  await page.getByTestId("hive-window-settings").waitFor();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  report.checks.push("Enter opens the Settings window from its alias");
  await page.keyboard.press("Control+k");
  // Workspace IDs come from the shared fixture; assert user-visible labels for duplicated apps.
  await search.fill("vscode");
  await page.waitForTimeout(150);
  assert((await options.allTextContents()).every((text) => text.startsWith("VS Code")));
  assert((await options.count()) > 0);
  report.checks.push("vscode finds editor apps without spelling the display name");
  await check("new terminal", "new-terminal", ["new-terminal"]);
  await check("clone repository", "new-project", ["new-project"]);
  await check("terminals", "new-terminal");
  await check("projects", "new-project");
  await search.fill("projects hive");
  await page.waitForTimeout(150);
  assert((await options.count()) > 0);
  assert(
    (await options.evaluateAll((items) => items.map((item) => item.dataset.actionId))).every((id) =>
      id.startsWith("repository:"),
    ),
  );
  report.checks.push("category-qualified project search shows only matching projects");
  await search.fill("codex");
  await page.waitForTimeout(150);
  const codexIds = await options.evaluateAll((items) => items.map((item) => item.dataset.actionId));
  assert(codexIds[0].startsWith("session:"));
  assert(codexIds.indexOf("dashboard:open-agents") > 0);
  report.checks.push("exact session names rank above Agents aliases across groups");
  await search.fill("thismatchesnothing");
  await page.waitForTimeout(150);
  assert.equal(await options.count(), 0);
  assert(await page.getByText("No matching windows or commands.").isVisible());
  report.checks.push("unrelated queries show a real empty state");
  await check("", "new-terminal");
  await check("settings", "dashboard:open-settings");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+k");
  await check("settings", "dashboard:open-settings", ["dashboard:open-settings"]);
  await page.screenshot({ path: resolve(evidence, "settings-mobile.png") });
  await search.fill("editor");
  await page.waitForTimeout(150);
  assert((await options.count()) > 0);
  assert((await options.allTextContents()).every((text) => text.startsWith("VS Code")));
  report.checks.push("mobile sheet shares app aliases and relevance ordering");
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await Promise.all([
    new Promise((done) => server.close(done)),
    new Promise((done) => app.close(done)),
  ]);
}
