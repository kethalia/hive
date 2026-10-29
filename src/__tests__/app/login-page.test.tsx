// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/app/login/login-form";

const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockRefresh.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps SSR controls disabled until actual React hydration enables handlers", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<LoginForm />);
    document.body.append(container);
    const email = within(container).getByLabelText("Email");
    const password = within(container).getByLabelText("Password");
    const submit = within(container).getByRole("button", { name: "Sign in" });
    expect(email).toBeDisabled();
    expect(password).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(container.querySelector("form")).toHaveAttribute("aria-busy", "true");
    submit.click();
    expect(fetch).not.toHaveBeenCalled();

    const recoverable = vi.fn();
    const view = render(<LoginForm />, {
      container,
      hydrate: true,
      onRecoverableError: recoverable,
    });
    await waitFor(() => expect(submit).toBeEnabled());
    // Hydration reused the original controls rather than replacing the SSR form.
    expect(within(container).getByLabelText("Email")).toBe(email);
    expect(within(container).getByLabelText("Password")).toBe(password);
    expect(email).toBeEnabled();
    expect(password).toBeEnabled();
    expect(container.querySelector("form")).toHaveAttribute("aria-busy", "false");
    expect(recoverable).not.toHaveBeenCalled();
    fireEvent.change(email, { target: { value: "operator@example.com" } });
    fireEvent.change(password, { target: { value: "secret" } });
    fireEvent.click(submit);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/workspaces"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        body: JSON.stringify({ email: "operator@example.com", password: "secret" }),
      }),
    );
    view.unmount();
    container.remove();
  });

  it("keeps controls disabled while login is pending and permits retry after an error", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<LoginForm />);
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    fireEvent.change(email, { target: { value: "operator@example.com" } });
    fireEvent.change(password, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(email).toBeDisabled();
    expect(password).toBeDisabled();
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    fireEvent.submit(email.closest("form")!);
    expect(fetch).toHaveBeenCalledOnce();
    finish(Response.json({ error: "Invalid credentials" }, { status: 401 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
    expect(email).toBeEnabled();
    expect(password).toBeEnabled();
    expect(email).toHaveValue("operator@example.com");
    expect(password).toHaveValue("secret");
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/workspaces"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("opens the workspace home after successful authentication", async () => {
    render(<LoginForm />);

    expect(screen.queryByLabelText("Coder URL")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "operator@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/workspaces");
      expect(mockRefresh).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/login",
        expect.objectContaining({
          body: JSON.stringify({ email: "operator@example.com", password: "secret" }),
        }),
      );
    });
  });
});
