import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HIVE_PLAYWRIGHT_MODULE || "playwright");
const output = process.env.HIVE_EVIDENCE_DIR || "/tmp/hive-agent-tools-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.HIVE_CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const report = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({
      viewport,
      isMobile: viewport.width < 500,
      hasTouch: viewport.width < 500,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:4187");
    await page.getByRole("heading", { name: "Recent conversations" }).waitFor();
    await page.getByText("hive · Codex").waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: `${output}/${viewport.width}-setup.png` });
    await page.getByLabel("Search agent sessions").fill("website");
    assert.equal(await page.getByText("hive · Codex").count(), 0);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForFunction(() =>
      document.body.dataset.openedSession?.startsWith("hive-claude-"),
    );
    await page.getByLabel("Search agent sessions").fill("hive");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.waitForFunction(() =>
      document.body.dataset.openedSession?.startsWith("hive-codex-"),
    );
    await page.getByRole("button", { name: "Enable tracking" }).click();
    await page.getByRole("button", { name: "Disable tracking" }).waitFor();
    await page.getByRole("listitem").filter({ hasText: "hive · Codex" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${viewport.width}-sessions.png` });
    await page.getByRole("button", { name: "Disable tracking" }).click();
    await page.getByRole("button", { name: "Enable tracking" }).waitFor();
    assert.equal(await page.evaluate(() => window.lastAgentOperation), "disable");
    await page.goto("http://127.0.0.1:4187/?failure=1");
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /Start this workspace first/);
    await page.getByRole("button", { name: "Refresh" }).waitFor();
    assert.deepEqual(errors, []);
    report.push({
      viewport,
      search: "passed",
      recoveryRouting: "passed",
      trackingControls: "passed",
      failureState: "passed",
      horizontalOverflow: false,
      pageErrors: errors,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(`${output}/browser-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
