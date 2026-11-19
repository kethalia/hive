// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ACCOUNT_REQUEST_TIMEOUT_MS,
  useWorkspaceAccountConnection,
} from "@/hooks/useWorkspaceAccountConnection";
import { codexAccountStatusSchema } from "@/lib/agents/codex-account-contracts";

const lifetimeId = "00000000-0000-4000-8000-000000000001";
const options = {
  workspaceId: "workspace",
  buildId: "build",
  provider: "codex" as const,
  schema: codexAccountStatusSchema,
};
function status(state = "signed-out", generation = 0, expiresAt = Date.now() + 600_000) {
  return {
    scope: "managed-native",
    lifetimeId,
    generation,
    state,
    pending:
      state === "pending"
        ? {
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-1234",
            expiresAt,
          }
        : null,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("aborts a hung read at its deadline and permits a fresh status request", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce(Response.json(status()));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useWorkspaceAccountConnection(options));
  expect(result.current.busy).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(ACCOUNT_REQUEST_TIMEOUT_MS));
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(result.current.busy).toBe(false);
  expect(result.current.failure).toEqual({ mutation: false });
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.status?.state).toBe("signed-out");
  expect(result.current.failure).toBeNull();
});

it("never replays a timed-out mutation and keeps its uncertainty through failed readback", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status()))
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockRejectedValueOnce(new Error("readback unavailable"))
    .mockResolvedValueOnce(Response.json(status("signed-in", 2)));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useWorkspaceAccountConnection(options));
  await act(async () => {});
  act(() => {
    void result.current.send({ action: "connect", lifetimeId, generation: 0 });
  });
  await act(async () => vi.advanceTimersByTimeAsync(ACCOUNT_REQUEST_TIMEOUT_MS + 9000));
  expect(result.current.failure).toEqual({ mutation: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.failure).toEqual({ mutation: true });
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.failure).toBeNull();
  expect(result.current.status?.state).toBe("signed-in");
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).request.action)).toEqual([
    "status",
    "connect",
    "status",
    "status",
  ]);
});

it("polls pending attempts serially while a previous poll remains active", async () => {
  vi.useFakeTimers();
  let reply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status("pending", 1)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(status("signed-in", 2)));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useWorkspaceAccountConnection(options));
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => reply(Response.json(status("pending", 1))));
  await act(async () => vi.advanceTimersByTimeAsync(2999));
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(result.current.status?.state).toBe("signed-in");
});

it("preempts a background read for explicit generation readback and ignores the old reply", async () => {
  let lateReply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status("signed-in", 1)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          lateReply = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(status("signed-in", 3)));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useWorkspaceAccountConnection(options));
  await act(async () => {});
  act(() => window.dispatchEvent(new Event("focus")));
  expect(result.current.busy).toBe(false);
  await act(async () => {
    await result.current.refresh();
  });
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
  expect(result.current.status?.generation).toBe(3);
  await act(async () => lateReply(Response.json(status("signed-in", 1))));
  expect(result.current.status?.generation).toBe(3);
});

it("does not preempt an active mutation for status or a second mutation", async () => {
  let reply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status("pending", 1)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useWorkspaceAccountConnection(options));
  await act(async () => {});
  act(() => {
    void result.current.send({ action: "cancel", lifetimeId, generation: 1 });
  });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await result.current.refresh();
    await result.current.send({ action: "connect", lifetimeId, generation: 1 });
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(false);
  await act(async () => reply(Response.json(status("cancelled", 2))));
  expect(result.current.status?.state).toBe("cancelled");
});

it("rechecks visible focus changes without overlapping requests and removes listeners on unmount", async () => {
  let reply!: (response: Response) => void;
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status()))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(status("signed-in", 1)));
  vi.stubGlobal("fetch", fetcher);
  const { unmount } = renderHook(() => useWorkspaceAccountConnection(options));
  await act(async () => {});
  act(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => reply(Response.json(status())));
  visibility.mockReturnValue("hidden");
  act(() => window.dispatchEvent(new Event("focus")));
  expect(fetcher).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetcher).toHaveBeenCalledTimes(3);
  unmount();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("aborts old scope requests and drops responses whose body resolves after a build switch", async () => {
  let body!: (value: unknown) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) => {
          body = resolve;
        }),
    })
    .mockResolvedValueOnce(Response.json(status("signed-out", 9)));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender, unmount } = renderHook(
    ({ buildId }) => useWorkspaceAccountConnection({ ...options, buildId }),
    { initialProps: { buildId: "old" } },
  );
  await act(async () => {});
  rerender({ buildId: "new" });
  await act(async () => {});
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(result.current.status?.generation).toBe(9);
  await act(async () => body(status("pending", 7)));
  expect(result.current.status?.generation).toBe(9);
  unmount();
});

it("aborts on unmount and clears request and polling deadlines", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const { unmount } = renderHook(() => useWorkspaceAccountConnection(options));
  unmount();
  await act(async () => {});
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the absolute expiry deadline to request status without mutating the attempt", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status("pending", 1, Date.now() + 1000)))
    .mockResolvedValueOnce(Response.json(status("expired", 2)));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useWorkspaceAccountConnection(options));
  await act(async () => {});
  expect(result.current.expiresIn).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.status?.state).toBe("expired");
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).request.action)).toEqual([
    "status",
    "status",
  ]);
});

it("suspends automatic checks for management while keeping explicit status readback available", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() => Promise.resolve(Response.json(status("signed-in", 3))));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() =>
    useWorkspaceAccountConnection({ ...options, suspended: true }),
  );
  await act(async () => {});
  act(() => window.dispatchEvent(new Event("focus")));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.refresh();
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.current.busy).toBe(false);
});
