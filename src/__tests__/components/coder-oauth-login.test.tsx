// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoderOAuthLogin } from "@/app/login/coder-oauth-login";

afterEach(cleanup);
describe("Coder OAuth login presentation", () => {
  it("navigates to the fixed local start route without collecting credentials or choosing a provider URL", () => {
    const { container } = render(<CoderOAuthLogin available error={null} />);
    const link = screen.getByRole("link", { name: "Continue with Coder" });
    expect(link.tagName).toBe("A");
    expect(link.textContent).toBe("Continue with Coder");
    expect(container.querySelector("button")).toBeNull();
    expect(link.getAttribute("href")).toBe("/api/auth/coder/start");
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(link.hasAttribute("disabled")).toBe(false);
    expect(container.textContent).not.toContain("client_secret");
  });
  it("does not offer a live start action or legacy password fallback when enabled configuration is unavailable", () => {
    const { container } = render(<CoderOAuthLogin available={false} error={null} />);
    expect(
      screen.getByRole("button", { name: "Continue with Coder" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("link", { name: "Continue with Coder" })).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
  it("offers retry after failed or cancelled consent with fixed copy", () => {
    render(<CoderOAuthLogin available error="failed" />);
    expect(screen.getByRole("alert").textContent).toContain("couldn’t complete");
    expect(screen.getByRole("link", { name: "Continue with Coder" }).getAttribute("href")).toBe(
      "/api/auth/coder/start",
    );
  });
});
