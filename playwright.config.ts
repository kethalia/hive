import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "test-results/playwright",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "tablet-chromium",
      use: { ...devices["iPad Pro 11"], browserName: "chromium" },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
  ],
});
