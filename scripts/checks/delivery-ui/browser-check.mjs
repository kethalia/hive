// Run only in the browser-testing workspace with its installed Chrome.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium, expect } from "@playwright/test";

if (process.env.HIVE_WORKSPACE_PROFILE !== "browser") throw new Error("Browser profile required");
const directory = resolve(process.argv[2] ?? "./site");
const evidence = resolve(process.argv[3] ?? "./evidence");
await mkdir(evidence, { recursive: true });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = resolve(directory, `.${path === "/" ? "/index.html" : path}`);
  if (!file.startsWith(directory + sep)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, {
      "content-type":
        {
          ".js": "text/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".json": "application/json",
          ".ttf": "font/ttf",
        }[extname(file)] ?? "application/octet-stream",
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const results = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const report = page.locator("details").filter({ hasText: "Synthetic reconnect check passed" });
    await expect(report).toHaveAttribute("open", "");
    await expect(report).toContainText("Difficulty: moderate");
    await expect(report).toContainText("simulated");
    await expect(page.getByText("Implementation and preview", { exact: false })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    const reportSummary = report.locator("summary");
    await reportSummary.focus();
    await page.keyboard.press("Enter");
    await expect(report).not.toHaveAttribute("open");
    await page.keyboard.press("Enter");
    await expect(report).toHaveAttribute("open", "");
    await page.screenshot({
      path: resolve(evidence, `delivery-${viewport.width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Conversation fixture", exact: true }).click();
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(40);
    await page.getByRole("button", { name: "Show earlier activity (5 turns)" }).click();
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(45);
    const command = page.locator("details").filter({ hasText: "Command · completed" });
    await command.locator("summary").click();
    await expect(command).toContainText("<script>must remain text</script>");
    expect(await page.locator("details script").count()).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await page.screenshot({
      path: resolve(evidence, `conversation-${viewport.width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Continue in Terminal", exact: false }).click();
    await expect(page.getByText("Terminal attachment requested", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Delivery fixture", exact: true }).click();
    await expect(page.getByText("Synthetic reconnect check passed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Simulate expired session", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Sign in again");
    await expect(page.getByText("Synthetic reconnect check passed", { exact: true })).toHaveCount(
      0,
    );
    expect(errors).toEqual([]);
    results.push({
      viewport,
      result: "passed",
      checks: [
        "report deep link",
        "evidence mode",
        "keyboard summary",
        "no horizontal overflow",
        "40-to-45 history",
        "command escaping",
        "terminal intent",
        "revocation clears content",
      ],
      pageErrors: errors,
    });
    await context.tracing.stop({ path: resolve(evidence, `trace-${viewport.width}.zip`) });
    await context.close();
  }
  await writeFile(
    resolve(evidence, "results.json"),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        browser: await browser.version(),
        profile: "browser",
        kind: "synthetic-component-browser",
        results,
        source: JSON.parse(await readFile(resolve(directory, "source-evidence.json"), "utf8")),
        nativeSessionVerified: false,
        authenticationVerified: false,
        productionVerified: false,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
