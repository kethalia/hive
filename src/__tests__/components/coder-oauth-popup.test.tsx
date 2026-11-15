// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
let readSession: ReturnType<typeof vi.fn>;
let startSocial: ReturnType<typeof vi.fn>;
const originalSession = "a".repeat(64);
const newSession = "b".repeat(64);

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
  readSession = vi.fn().mockImplementation(async () => Response.json({ session: null }));
  startSocial = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ url: "https://coder.example.com/oauth2/authorize" }),
    );
  fetcher = vi.fn((path, options) => {
    if (path === "/api/auth/coder/session") return readSession(options);
    if (path === "/api/auth/sign-in/social") return startSocial(options);
    throw Error(`Unexpected fetch ${path}`);
  });
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

async function openSignIn() {
  const view = render(<CoderOAuthLogin />);
  await act(async () => fireEvent.click(screen.getByRole("button")));
  return view;
}

describe("Coder OAuth popup", () => {
  it("opens the popup before the baseline read and starts OAuth only after that read", async () => {
    let finishBaseline!: (response: Response) => void;
    readSession.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishBaseline = resolve;
      }),
    );
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
    expect(startSocial).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/coder/session",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }),
    );
    await act(async () => finishBaseline(Response.json({ session: null })));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/sign-in/social",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ provider: "coder", popup: attempt }),
      }),
    );
    expect(popup.location.replace).toHaveBeenCalledWith(
      "https://coder.example.com/oauth2/authorize",
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Complete sign-in in the Coder window");
  });

  it("reports a blocked popup without starting any network request", () => {
    vi.mocked(window.open).mockReturnValue(null);
    render(<CoderOAuthLogin />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("alert")).toHaveTextContent("Allow pop-ups");
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("accepts completion only from the expected window, origin and attempt after server verification", async () => {
    await openSignIn();
    act(() => {
      message({ origin: "https://foreign.invalid" });
      message({ source: window });
      message({ data: { type: CODER_OAUTH_POPUP_MESSAGE, attempt: "different", success: true } });
      message({ data: { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: "true" } });
    });
    expect(readSession).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
    readSession.mockResolvedValueOnce(Response.json({ session: newSession }));
    await act(async () => message());
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(router.replace).toHaveBeenCalledWith("/workspaces");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalled();
  });

  it("does not authenticate a successful popup message when the server still has no session", async () => {
    vi.useFakeTimers();
    await openSignIn();
    await act(async () => message());
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(readSession).toHaveBeenCalledTimes(4);
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("keeps a loading state after the popup closes until workspace navigation unmounts login", async () => {
    vi.useFakeTimers();
    const view = await openSignIn();
    readSession.mockResolvedValueOnce(Response.json({ session: newSession }));
    await act(async () => message());
    expect(popup.close).toHaveBeenCalledOnce();
    expect(router.replace).toHaveBeenCalledWith("/workspaces");
    expect(screen.getByRole("button", { name: "Opening your workspace…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sign-in complete. Loading your workspace.",
    );
    expect(screen.queryByRole("button", { name: "Continue with Coder" })).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    fireEvent.click(screen.getByRole("button", { name: "Opening your workspace…" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading your workspace");
    expect(startSocial).toHaveBeenCalledOnce();
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(window.open).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("recovers a dropped completion message through the serialized session poll", async () => {
    vi.useFakeTimers();
    await openSignIn();
    readSession.mockResolvedValueOnce(Response.json({ session: newSession }));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(router.replace).toHaveBeenCalledWith("/workspaces");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opening your workspace…" })).toBeDisabled();
  });

  it("checks the server after a manual popup close and accepts an already committed session", async () => {
    vi.useFakeTimers();
    await openSignIn();
    readSession.mockResolvedValueOnce(Response.json({ session: newSession }));
    popup.close();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(router.replace).toHaveBeenCalledWith("/workspaces");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opening your workspace…" })).toBeDisabled();
  });

  it("requires a new session even after a matching success message", async () => {
    vi.useFakeTimers();
    readSession.mockImplementation(async () => Response.json({ session: originalSession }));
    await openSignIn();
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
    await act(async () => message());
    expect(router.replace).not.toHaveBeenCalled();
    readSession.mockImplementation(async () => Response.json({ session: newSession }));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(router.replace).toHaveBeenCalledWith("/workspaces");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("shows callback failure and closes the popup when the server cannot verify a session", async () => {
    await openSignIn();
    await act(async () =>
      message({ data: { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: false } }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("did not complete");
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
    expect(popup.close).toHaveBeenCalled();
  });

  it.each([
    "unavailable",
    "invalid",
  ])("stops before OAuth when baseline session observation is %s", async (failure) => {
    readSession.mockResolvedValueOnce(
      failure === "unavailable"
        ? new Response(null, { status: 503 })
        : Response.json({ session: "invalid" }),
    );
    await openSignIn();
    expect(screen.getByRole("alert")).toHaveTextContent("could not start");
    expect(startSocial).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("closes the popup on a failed OAuth start", async () => {
    startSocial.mockRejectedValue(new Error("offline"));
    await openSignIn();
    expect(screen.getByRole("alert")).toHaveTextContent("could not start");
    expect(popup.close).toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("finishes the manual-close server check before reporting cancellation and aborts the pending start", async () => {
    vi.useFakeTimers();
    startSocial.mockReturnValue(new Promise(() => {}));
    await openSignIn();
    const signal: AbortSignal = startSocial.mock.calls[0][0].signal;
    let finishCheck!: (response: Response) => void;
    readSession.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishCheck = resolve;
      }),
    );
    popup.close();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(signal.aborted).toBe(false);
    await act(async () => finishCheck(Response.json({ session: null })));
    expect(screen.getByRole("alert")).toHaveTextContent("window was closed");
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("shares one pending verification across polling, messages and popup closure", async () => {
    vi.useFakeTimers();
    await openSignIn();
    let finishCheck!: (response: Response) => void;
    readSession.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishCheck = resolve;
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => message());
    popup.close();
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(readSession).toHaveBeenCalledTimes(2);
    await act(async () => finishCheck(Response.json({ session: newSession })));
    expect(router.replace).toHaveBeenCalledOnce();
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    "null",
    "rejected",
  ])("drains a pre-close %s poll before one fresh check of the committed cookie", async (result) => {
    vi.useFakeTimers();
    await openSignIn();
    let finishOldCheck!: (response: Response) => void;
    let rejectOldCheck!: (error: Error) => void;
    let finishFreshCheck!: (response: Response) => void;
    readSession
      .mockReturnValueOnce(
        new Promise<Response>((resolve, reject) => {
          finishOldCheck = resolve;
          rejectOldCheck = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finishFreshCheck = resolve;
        }),
      );
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    popup.close();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      if (result === "null") finishOldCheck(Response.json({ session: null }));
      else rejectOldCheck(new Error("Old request unavailable"));
    });
    expect(readSession).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(readSession).toHaveBeenCalledTimes(3);
    await act(async () => finishFreshCheck(Response.json({ session: newSession })));
    expect(router.replace).toHaveBeenCalledWith("/workspaces");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(readSession).toHaveBeenCalledTimes(3);
  });

  it("expires the popup with the framework's ten-minute state lifetime", async () => {
    vi.useFakeTimers();
    await openSignIn();
    await act(() => vi.advanceTimersByTimeAsync(600_000));
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
    expect(popup.close).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    "baseline",
    "start",
    "verification",
  ])("aborts the active %s request and stops all polling on unmount", async (phase) => {
    vi.useFakeTimers();
    if (phase === "baseline") readSession.mockReturnValueOnce(new Promise(() => {}));
    if (phase === "start") startSocial.mockReturnValueOnce(new Promise(() => {}));
    const view = await openSignIn();
    if (phase === "verification") {
      readSession.mockReturnValueOnce(new Promise(() => {}));
      await act(() => vi.advanceTimersByTimeAsync(2_000));
    }
    const signal: AbortSignal =
      phase === "start"
        ? startSocial.mock.calls.at(-1)![0].signal
        : readSession.mock.calls.at(-1)![0].signal;
    const calls = fetcher.mock.calls.length;
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(popup.close).toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    act(() => message());
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(router.replace).not.toHaveBeenCalled();
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
