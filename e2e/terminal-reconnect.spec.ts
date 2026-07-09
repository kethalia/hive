import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const harnessUrl = pathToFileURL(
  path.join(process.cwd(), "e2e", "fixtures", "terminal-reconnect-harness.html"),
).toString();

test("foreground lifecycle keeps healthy sessions stable and refreshes a lost session once", async ({
  page,
}, testInfo) => {
  await page.goto(harnessUrl);

  await expect(page.getByTestId("session-main")).toHaveAttribute("data-state", "connected");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-state", "connected");

  await page.evaluate(() => {
    window.terminalReconnectHarness.background();
  });
  await page.evaluate(async () => {
    await window.terminalReconnectHarness.foregroundBurst();
  });

  await expect(page.getByTestId("session-main")).toHaveAttribute("data-refreshes", "0");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-refreshes", "0");

  await page.evaluate(() => {
    window.terminalReconnectHarness.drop("clone");
  });
  await page.evaluate(async () => {
    await window.terminalReconnectHarness.foregroundBurst();
  });

  await expect(page.getByTestId("session-main")).toHaveAttribute("data-refreshes", "0");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-refreshes", "1");
  await expect(page.getByTestId("session-clone")).toHaveAttribute("data-state", "connected");

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("terminal-reconnect-visual.png"),
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
});

declare global {
  interface Window {
    terminalReconnectHarness: {
      background: () => void;
      drop: (name: "main" | "clone") => void;
      foregroundBurst: () => Promise<void>;
    };
  }
}
