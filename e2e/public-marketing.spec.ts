import { expect, test } from "@playwright/test";

const appUrl = process.env.PLAYWRIGHT_BASE_URL;

test.describe("public marketing and auth boundary", () => {
  test.skip(!appUrl, "Set PLAYWRIGHT_BASE_URL to run deployed-app checks.");

  test("renders the public story without overflow and hands off to login", async ({ page }) => {
    await page.goto(new URL("/", appUrl).toString());

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Build in context.Stay in the loop.",
    );
    await expect(page.getByRole("heading", { name: /From profile to focused work/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Designed for conversation/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open console" })).toBeVisible();

    const viewportHasNoHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    );
    expect(viewportHasNoHorizontalOverflow).toBe(true);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();

    await page.getByRole("link", { name: "Open console" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Connect your Coder" })).toBeVisible();
  });

  test("keeps private dashboard routes behind authentication", async ({ page }) => {
    await page.goto(new URL("/workspaces", appUrl).toString());
    await expect(page).toHaveURL(/\/login$/);
  });
});
