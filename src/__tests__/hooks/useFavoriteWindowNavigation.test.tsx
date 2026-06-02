// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFavoriteWindowNavigation } from "@/hooks/useFavoriteWindowNavigation";
import { resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import { listNavigationFavoritesAction } from "@/lib/actions/navigation-favorites";
import type { NavigationFavoriteDto } from "@/lib/actions/navigation-favorites";

const navigationState = vi.hoisted(() => ({
  search: "session=alpha",
  router: {
    replace: vi.fn(),
    push: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigationState.router,
  useSearchParams: () => new URLSearchParams(navigationState.search),
}));

vi.mock("@/lib/actions/navigation-favorites", () => ({
  listNavigationFavoritesAction: vi.fn(),
}));

vi.mock("@/lib/actions/git-clones", () => ({
  resolveGitCloneTerminalAction: vi.fn(),
}));

const mockListNavigationFavoritesAction = vi.mocked(listNavigationFavoritesAction);
const mockResolveGitCloneTerminalAction = vi.mocked(resolveGitCloneTerminalAction);

function terminalFavorite(overrides: Partial<NavigationFavoriteDto> = {}): NavigationFavoriteDto {
  return {
    id: "fav-terminal-alpha",
    kind: "terminal",
    workspaceId: "workspace-1",
    targetKey: "alpha",
    label: "Alpha terminal",
    relativePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function gitFavorite(overrides: Partial<NavigationFavoriteDto> = {}): NavigationFavoriteDto {
  return {
    id: "fav-git-hive",
    kind: "git",
    workspaceId: "workspace-1",
    targetKey: "git-clone:Git/projects/kethalia/hive",
    label: "Hive repo",
    relativePath: "projects/kethalia/hive",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function setSearch(search: string) {
  navigationState.search = search;
}

describe("useFavoriteWindowNavigation", () => {
  beforeEach(() => {
    setSearch("session=alpha");
    navigationState.router.replace.mockClear();
    navigationState.router.push.mockClear();
    mockListNavigationFavoritesAction.mockReset();
    mockResolveGitCloneTerminalAction.mockReset();
    mockListNavigationFavoritesAction.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads favorite windows instead of terminal sessions and selects terminal favorites by id", async () => {
    mockListNavigationFavoritesAction.mockResolvedValue({
      data: [
        terminalFavorite(),
        terminalFavorite({ id: "fav-terminal-bravo", targetKey: "bravo", label: "Bravo terminal" }),
      ],
    });

    const { result } = renderHook(() => useFavoriteWindowNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockListNavigationFavoritesAction).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
    expect(result.current.sessions.map((session) => session.name)).toEqual([
      "Alpha terminal",
      "Bravo terminal",
    ]);
    expect(result.current.current?.name).toBe("Alpha terminal");
    expect(result.current.next?.name).toBe("Bravo terminal");

    act(() => {
      expect(result.current.select("fav-terminal-bravo")).toBe(true);
    });

    expect(navigationState.router.replace).toHaveBeenCalledWith(
      "/workspaces/workspace-1/terminal?session=bravo",
    );
    expect(mockResolveGitCloneTerminalAction).not.toHaveBeenCalled();
  });

  it("opens Git favorites through the clone terminal resolver and preserves debug viewport", async () => {
    setSearch("session=git-clone-hive&clonePath=projects/kethalia/hive&debugViewport=1");
    mockListNavigationFavoritesAction.mockResolvedValue({ data: [gitFavorite()] });
    mockResolveGitCloneTerminalAction.mockResolvedValue({
      data: {
        sessionName: "git-clone-safe",
        cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
        clonePath: "projects/kethalia/hive",
        cloneProof: "proof-123",
      },
    });

    const { result } = renderHook(() => useFavoriteWindowNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.current?.name).toBe("Hive repo");

    act(() => {
      expect(result.current.select("fav-git-hive")).toBe(true);
    });

    await waitFor(() =>
      expect(navigationState.router.push).toHaveBeenCalledWith(
        "/workspaces/workspace-1/terminal?session=git-clone-safe&clonePath=projects%2Fkethalia%2Fhive&cloneProof=proof-123&debugViewport=1",
      ),
    );
    expect(mockResolveGitCloneTerminalAction).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
      relativePath: "projects/kethalia/hive",
    });
  });

  it("reports favorite loading failures without falling back to terminal sessions", async () => {
    mockListNavigationFavoritesAction.mockResolvedValue({ serverError: "Favorites unavailable" });

    const { result } = renderHook(() => useFavoriteWindowNavigation("workspace-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBe("Favorites unavailable");
    expect(result.current.select("missing")).toBe(false);
  });
});
