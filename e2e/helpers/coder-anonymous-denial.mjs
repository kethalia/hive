import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Missing desktop DOM is not evidence of denial: public pages can load slowly.
// Require the configured Coder origin's successful login page and visible UI.
export async function verifyAnonymousCoderLogin(page, { appUrl, coderUrl, timeout = 20000 }) {
  const origin = new URL(coderUrl).origin;
  const response = await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout });
  assert.ok(response?.ok(), "Anonymous navigation did not return a successful login response");
  await page.waitForURL((url) => url.origin === origin && url.pathname === "/login", { timeout });
  await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible({ timeout });
  const url = new URL(page.url());
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, "/login");
  return { kind: "coder-login", origin, pathname: url.pathname, status: response.status() };
}
