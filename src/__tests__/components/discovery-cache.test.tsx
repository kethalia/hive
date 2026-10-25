// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiscovery } from "@/lib/discovery/queries";
import { readDiscovery } from "@/lib/discovery/transport";
import { DiscoveryError } from "@/lib/discovery/types";

vi.mock("@/lib/discovery/transport", () => ({ readDiscovery: vi.fn() }));
let client: QueryClient;
const read = vi.mocked(readDiscovery);
const target = { workspaceId: "dev", buildId: "build-1" };
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient();
  read.mockReset();
  read.mockResolvedValue([{ name: "main" }] as never);
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("shared browser discovery", () => {
  it("deduplicates consumers and reuses a warm snapshot immediately on remount", async () => {
    const first = renderHook(() => useDiscovery("sessions", target), { wrapper });
    const second = renderHook(() => useDiscovery("sessions", target), { wrapper });
    await waitFor(() => expect(first.result.current.data).toEqual([{ name: "main" }]));
    expect(second.result.current.data).toEqual([{ name: "main" }]);
    expect(read).toHaveBeenCalledTimes(1);
    first.unmount();
    second.unmount();
    const reopened = renderHook(() => useDiscovery("sessions", target), { wrapper });
    expect(reopened.result.current.data).toEqual([{ name: "main" }]);
    expect(reopened.result.current.isPending).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("keeps prior results through transient refresh errors, but hides denied data until recovery", async () => {
    const hook = renderHook(() => useDiscovery("sessions", target), { wrapper });
    await waitFor(() => expect(hook.result.current.data).toBeDefined());
    read.mockRejectedValue(new DiscoveryError("offline", 503));
    await act(async () => {
      await hook.result.current.refresh().catch(() => {});
    });
    await waitFor(() => expect(hook.result.current.error?.message).toBe("offline"));
    expect(hook.result.current.data).toEqual([{ name: "main" }]);
    read.mockRejectedValue(new DiscoveryError("denied", 403));
    await act(async () => {
      await hook.result.current.refresh().catch(() => {});
    });
    await waitFor(() => expect(hook.result.current.data).toBeUndefined());
    hook.unmount();
    const reopened = renderHook(() => useDiscovery("sessions", target), { wrapper });
    expect(reopened.result.current.data).toBeUndefined();
    await waitFor(() => expect(reopened.result.current.isFetching).toBe(false));
    read.mockResolvedValue([]);
    await act(async () => {
      await reopened.result.current.refresh();
    });
    await waitFor(() => expect(reopened.result.current.data).toEqual([]));
  });
  it("isolates builds and cancels requests from unmounted consumers", async () => {
    const hook = renderHook(({ buildId }) => useDiscovery("sessions", { ...target, buildId }), {
      wrapper,
      initialProps: { buildId: "old" },
    });
    await waitFor(() => expect(hook.result.current.data).toBeDefined());
    let finish!: (data: never[]) => void;
    read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    hook.rerender({ buildId: "new" });
    expect(hook.result.current.data).toBeUndefined();
    const signal = read.mock.calls.at(-1)![2]!;
    hook.unmount();
    expect(signal.aborted).toBe(true);
    finish([]);
  });
  it("does not fetch disabled resources and seeds existing server-rendered data", () => {
    const hook = renderHook(
      () => useDiscovery("sessions", target, { enabled: false, initialData: [] }),
      { wrapper },
    );
    expect(hook.result.current.data).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
