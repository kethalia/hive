// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockNavigateAfterLogin = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/post-login-navigation", () => ({
  navigateAfterLogin: mockNavigateAfterLogin,
}));

import LoginPage from "@/app/login/page";

function fillLoginForm() {
  fireEvent.change(screen.getByLabelText("Coder URL"), {
    target: { value: "https://coder.example.com" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "test@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "pass123" },
  });
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("performs a full navigation after a successful login response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    render(<LoginPage />);
    fillLoginForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(mockNavigateAfterLogin).toHaveBeenCalledWith("/");
    });
    expect(fetch).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coderUrl: "https://coder.example.com",
        email: "test@example.com",
        password: "pass123",
      }),
    });
  });

  it("shows the server error and stays on the login page when login fails", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    render(<LoginPage />);
    fillLoginForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("invalid credentials")).toBeInTheDocument();
    expect(mockNavigateAfterLogin).not.toHaveBeenCalled();
  });
});
