// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { CoderOAuthLogin } from "@/app/login/coder-oauth-login";
import { CoderOAuthComplete } from "@/app/login/complete/result";
import { CODER_OAUTH_POPUP_MESSAGE } from "@/lib/auth/coder-oauth-popup";

const attempt = "f5ed9902-3689-49ee-ad83-050fdbe6abc9";
let popup: Window;
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  const value = {
    closed: false,
    document: { title: "", body: { textContent: "" } },
    location: { replace: vi.fn() },
    close: vi.fn(() => {
      value.closed = true;
    }),
  };
  popup = value as unknown as Window;
  vi.spyOn(window, "open").mockReturnValue(popup);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(attempt);
  fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ url: "https://coder.example.com/oauth2/authorize" }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function message(overrides: Partial<MessageEventInit> = {}) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: window.location.origin,
      source: popup,
      data: { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: true },
      ...overrides,
    }),
  );
}

describe("Coder OAuth popup", () => {
  it("opens a popup synchronously and navigates only that window to Coder", async () => {
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Coder" }));
    expect(window.open).toHaveBeenCalledWith(
      "about:blank",
      `hive-coder-${attempt}`,
      "popup,width=560,height=720",
    );
    expect(vi.mocked(window.open).mock.invocationCallOrder[0]).toBeLessThan(
      fetcher.mock.invocationCallOrder[0],
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/sign-in/social",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ provider: "coder", popup: attempt }),
      }),
    );
    await waitFor(() =>
      expect(popup.location.replace).toHaveBeenCalledWith(
        "https://coder.example.com/oauth2/authorize",
      ),
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Complete sign-in in the Coder window");
  });

  it("reports a blocked popup without starting an OAuth flow", () => {
    vi.mocked(window.open).mockReturnValue(null);
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Coder" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Allow pop-ups");
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("accepts completion only from the expected window, origin and attempt", async () => {
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    act(() => {
      message({ origin: "https://foreign.invalid" });
      message({ source: window });
      message({ data: { type: CODER_OAUTH_POPUP_MESSAGE, attempt: "different", success: true } });
    });
    expect(router.replace).not.toHaveBeenCalled();
    act(() => message());
    expect(router.replace).toHaveBeenCalledWith("/workspaces");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalled();
  });

  it("shows callback failure and closes the popup while permitting retry", async () => {
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    act(() => message({ data: { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: false } }));
    expect(screen.getByRole("alert")).toHaveTextContent("did not complete");
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
    expect(popup.close).toHaveBeenCalled();
  });

  it("closes the popup on a failed start", async () => {
    fetcher.mockRejectedValue(new Error("offline"));
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not start");
    expect(popup.close).toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("handles a manually closed popup and cancels the pending request", async () => {
    vi.useFakeTimers();
    fetcher.mockReturnValue(new Promise(() => {}));
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button"));
    const signal: AbortSignal = fetcher.mock.calls[0][1].signal;
    popup.close();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByRole("alert")).toHaveTextContent("window was closed");
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("expires the popup with the framework's ten-minute state lifetime", async () => {
    vi.useFakeTimers();
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button"));
    await act(() => vi.advanceTimersByTimeAsync(600_000));
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
    expect(popup.close).toHaveBeenCalled();
  });

  it("cleans up the popup and request on unmount", () => {
    fetcher.mockReturnValue(new Promise(() => {}));
    const view = render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button"));
    const signal: AbortSignal = fetcher.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(popup.close).toHaveBeenCalled();
  });
});

describe("Coder OAuth completion", () => {
  it.each([
    true,
    false,
  ])("posts verified result %s only to the Hive origin and closes", (success) => {
    const opener = { postMessage: vi.fn() };
    vi.stubGlobal("opener", opener);
    vi.spyOn(window, "close").mockImplementation(() => {});
    render(<CoderOAuthComplete attempt={attempt} success={success} />);
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success },
      window.location.origin,
    );
    expect(window.close).toHaveBeenCalled();
  });

  it("offers a return path when the opener is unavailable", () => {
    vi.stubGlobal("opener", null);
    vi.spyOn(window, "close").mockImplementation(() => {});
    render(<CoderOAuthComplete attempt={attempt} success />);
    expect(window.close).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open Hive" })).toHaveAttribute("href", "/workspaces");
  });
});
