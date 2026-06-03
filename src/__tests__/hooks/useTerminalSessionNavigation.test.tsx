// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalSessionNavigation } from "@/hooks/useTerminalSessionNavigation";
import { getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import type { TmuxSession } from "@/lib/workspaces/sessions";

const navigationState = vi.hoisted(() => ({
  search: "session=alpha",
  router: {
    replace: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigationState.router,
  useSearchParams: () => new URLSearchParams(navigationState.search),
}));

vi.mock("@/lib/actions/workspaces", () => ({
  getWorkspaceSessionsAction: vi.fn(),
}));

const mockGetWorkspaceSessionsAction = vi.mocked(getWorkspaceSessionsAction);

function session(name: string, created = 1, windows = 1): TmuxSession {
  return { name, created, windows };
}

function setSearch(search: string) {
  navigationState.search = search;
}

describe("useTerminalSessionNavigation", () => {
  beforeEach(() => {
    setSearch("session=alpha");
    navigationState.router.replace.mockClear();
    mockGetWorkspaceSessionsAction.mockReset();
    mockGetWorkspaceSessionsAction.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not list sessions when no active route session exists", () => {
    setSearch("");

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    expect(mockGetWorkspaceSessionsAction).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      sessions: [],
      current: null,
      previous: null,
      next: null,
      canGoPrevious: false,
      canGoNext: false,
      loading: false,
      error: null,
    });
  });

  it("exposes loading while the session list action is pending", async () => {
    let resolveSessions: (value: { data: TmuxSession[] }) => void = () => undefined;
    mockGetWorkspaceSessionsAction.mockReturnValue(
      new Promise((resolve) => {
        resolveSessions = resolve;
      }),
    );

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();

    act(() => resolveSessions({ data: [session("alpha")] }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.current?.name).toBe("alpha");
  });

  it("computes one-session navigation without previous or next entries", async () => {
    mockGetWorkspaceSessionsAction.mockResolvedValue({ data: [session("alpha")] });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions.map((item) => item.name)).toEqual(["alpha"]);
    expect(result.current.current?.name).toBe("alpha");
    expect(result.current.previous).toBeNull();
    expect(result.current.next).toBeNull();
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.canGoNext).toBe(false);
  });

  it("computes ordered previous and next sessions for multiple sessions", async () => {
    setSearch("session=bravo");
    mockGetWorkspaceSessionsAction.mockResolvedValue({
      data: [session("alpha"), session("bravo"), session("charlie")],
    });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions.map((item) => item.name)).toEqual(["alpha", "bravo", "charlie"]);
    expect(result.current.current?.name).toBe("bravo");
    expect(result.current.previous?.name).toBe("alpha");
    expect(result.current.next?.name).toBe("charlie");
    expect(result.current.canGoPrevious).toBe(true);
    expect(result.current.canGoNext).toBe(true);
  });

  it("disables relative navigation when the active route session is missing", async () => {
    setSearch("session=missing");
    mockGetWorkspaceSessionsAction.mockResolvedValue({
      data: [session("alpha"), session("bravo")],
    });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.current).toBeNull();
    expect(result.current.previous).toBeNull();
    expect(result.current.next).toBeNull();
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.canGoNext).toBe(false);
  });

  it("treats server errors as navigation errors instead of empty lists", async () => {
    mockGetWorkspaceSessionsAction.mockResolvedValue({
      serverError: "Workspace agent unavailable",
    });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBe("Workspace agent unavailable");
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.canGoNext).toBe(false);
  });

  it("treats thrown action failures as navigation errors", async () => {
    mockGetWorkspaceSessionsAction.mockRejectedValue(new Error("tmux list failed"));

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBe("tmux list failed");
  });

  it("keeps zero-session responses as a successful disabled state", async () => {
    mockGetWorkspaceSessionsAction.mockResolvedValue({ data: [] });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.current).toBeNull();
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.canGoNext).toBe(false);
  });

  it("filters clone sessions and malformed items before selection", async () => {
    mockGetWorkspaceSessionsAction.mockResolvedValue({
      data: [
        session("alpha"),
        session("git-clone-repo"),
        { name: "malformed" },
        { created: 2, windows: 1 },
        session("bravo"),
      ] as unknown as TmuxSession[],
    });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions.map((item) => item.name)).toEqual(["alpha", "bravo"]);

    act(() => {
      expect(result.current.select("git-clone-repo")).toBe(false);
      expect(result.current.select("malformed")).toBe(false);
    });
    expect(navigationState.router.replace).not.toHaveBeenCalled();
  });

  it("URL-encodes selected sessions, preserves only debugViewport=1, and strips clone params", async () => {
    setSearch("session=alpha&debugViewport=1&clonePath=/tmp/repo&cloneProof=secret&other=ignored");
    mockGetWorkspaceSessionsAction.mockResolvedValue({
      data: [session("alpha"), session("two words")],
    });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      expect(result.current.select("two words")).toBe(true);
    });

    expect(navigationState.router.replace).toHaveBeenCalledWith(
      "/workspaces/workspace-1/terminal?session=two%20words&debugViewport=1",
    );
  });

  it("does not preserve debugViewport values other than 1", async () => {
    setSearch("session=alpha&debugViewport=true&clonePath=/tmp/repo&cloneProof=secret");
    mockGetWorkspaceSessionsAction.mockResolvedValue({
      data: [session("alpha"), session("beta/slash")],
    });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      expect(result.current.select("beta/slash")).toBe(true);
    });

    expect(navigationState.router.replace).toHaveBeenCalledWith(
      "/workspaces/workspace-1/terminal?session=beta%2Fslash",
    );
  });

  it("reloads with one explicit additional session-list action", async () => {
    mockGetWorkspaceSessionsAction
      .mockResolvedValueOnce({ data: [session("alpha")] })
      .mockResolvedValueOnce({ data: [session("alpha"), session("bravo")] });

    const { result } = renderHook(() => useTerminalSessionNavigation("workspace-1"));

    await waitFor(() =>
      expect(result.current.sessions.map((item) => item.name)).toEqual(["alpha"]),
    );

    act(() => result.current.reload());

    await waitFor(() =>
      expect(result.current.sessions.map((item) => item.name)).toEqual(["alpha", "bravo"]),
    );
    expect(mockGetWorkspaceSessionsAction).toHaveBeenCalledTimes(2);
    expect(mockGetWorkspaceSessionsAction).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
    });
    expect(mockGetWorkspaceSessionsAction).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
    });
  });
});
