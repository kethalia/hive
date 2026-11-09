// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoderOAuthLogin } from "@/app/login/coder-oauth-login";

const startUrl =
  "https://codex-delivery-system-design-hive.b00ste.workers.dev/api/auth/coder/start";
afterEach(cleanup);
describe("Coder OAuth login presentation", () => {
  it("navigates to the registered origin start route without collecting credentials or choosing a provider URL", () => {
    const { container } = render(<CoderOAuthLogin startUrl={startUrl} error={null} />);
    const link = screen.getByRole("link", { name: "Continue with Coder" });
    expect(link.tagName).toBe("A");
    expect(link.textContent).toBe("Continue with Coder");
    expect(container.querySelector("button")).toBeNull();
    expect(link.getAttribute("href")).toBe(startUrl);
    expect(
      new URL(link.getAttribute("href")!, "https://7a7e9134-hive.b00ste.workers.dev").href,
    ).toBe(startUrl);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(link.hasAttribute("disabled")).toBe(false);
    expect(container.textContent).not.toContain("client_secret");
  });
  it("does not offer a live start action or legacy password fallback when enabled configuration is unavailable", () => {
    const { container } = render(<CoderOAuthLogin startUrl={null} error={null} />);
    expect(
      screen.getByRole("button", { name: "Continue with Coder" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("link", { name: "Continue with Coder" })).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
  it("offers retry after failed or cancelled consent with fixed copy", () => {
    render(<CoderOAuthLogin startUrl={startUrl} error="failed" />);
    expect(screen.getByRole("alert").textContent).toContain("couldn’t complete");
    expect(screen.getByRole("link", { name: "Continue with Coder" }).getAttribute("href")).toBe(
      startUrl,
    );
  });
});
