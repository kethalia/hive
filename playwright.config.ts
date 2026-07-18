import { defineConfig, devices } from "@playwright/test";

const hostResolverRules = process.env.HIVE_E2E_HOST_RESOLVER_RULES;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "test-results/playwright",
  use: {
    ignoreHTTPSErrors: process.env.HIVE_E2E_IGNORE_HTTPS_ERRORS === "true",
    launchOptions: hostResolverRules
      ? { args: [`--host-resolver-rules=${hostResolverRules}`] }
      : {},
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
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 15 Pro"], browserName: "webkit" },
    },
  ],
});
