"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import {
  listNavigationFavoritesAction,
  type NavigationFavoriteDto,
} from "@/lib/actions/navigation-favorites";

interface FavoriteWindowSession {
  id: string;
  name: string;
  favorite: NavigationFavoriteDto;
}

export interface FavoriteWindowNavigationState {
  sessions: FavoriteWindowSession[];
  current: FavoriteWindowSession | null;
  previous: FavoriteWindowSession | null;
  next: FavoriteWindowSession | null;
  canGoPrevious: boolean;
  canGoNext: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
  select: (favoriteId: string) => boolean;
}

function isNavigationFavoriteDto(value: unknown): value is NavigationFavoriteDto {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<NavigationFavoriteDto>;
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "terminal" || candidate.kind === "git") &&
    typeof candidate.workspaceId === "string" &&
    candidate.workspaceId.length > 0 &&
    typeof candidate.targetKey === "string" &&
    candidate.targetKey.length > 0 &&
    (typeof candidate.label === "string" || candidate.label === null) &&
    (typeof candidate.relativePath === "string" || candidate.relativePath === null) &&
    typeof candidate.createdAt === "string"
  );
}

function favoriteLabel(favorite: NavigationFavoriteDto): string {
  const label = favorite.label?.trim();
  if (label) return label;
  if (favorite.kind === "git") return favorite.relativePath ?? "Git repository";
  return favorite.targetKey;
}

function favoriteHref(
  workspaceId: string,
  sessionName: string,
  debugViewportEnabled: boolean,
): string {
  const href = `/workspaces/${encodeURIComponent(workspaceId)}/terminal?session=${encodeURIComponent(
    sessionName,
  )}`;
  return debugViewportEnabled ? `${href}&debugViewport=1` : href;
}

function gitFavoriteHref(
  workspaceId: string,
  identity: { sessionName: string; clonePath: string; cloneProof: string },
  debugViewportEnabled: boolean,
): string {
  const params = new URLSearchParams({
    session: identity.sessionName,
    clonePath: identity.clonePath,
    cloneProof: identity.cloneProof,
  });
  if (debugViewportEnabled) params.set("debugViewport", "1");
  return `/workspaces/${encodeURIComponent(workspaceId)}/terminal?${params.toString()}`;
}

export function useFavoriteWindowNavigation(workspaceId: string): FavoriteWindowNavigationState {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSessionName = searchParams.get("session");
  const activeClonePath = searchParams.get("clonePath");
  const debugViewportEnabled = searchParams.get("debugViewport") === "1";
  const [favorites, setFavorites] = useState<NavigationFavoriteDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // The reload key intentionally retriggers this route-authoritative list action.
    void reloadKey;

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function loadFavorites() {
      try {
        const result = await listNavigationFavoritesAction({ workspaceId });
        if (cancelled) return;

        if (result?.serverError) {
          setFavorites([]);
          setError(result.serverError);
          return;
        }

        if (!result || !Array.isArray(result.data) || !result.data.every(isNavigationFavoriteDto)) {
          setFavorites([]);
          setError("Failed to load favorite windows");
          return;
        }

        setFavorites(result.data);
      } catch (loadError) {
        if (cancelled) return;
        setFavorites([]);
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load favorite windows",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadFavorites();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadKey]);

  const sessions = useMemo<FavoriteWindowSession[]>(
    () =>
      favorites.map((favorite) => ({
        id: favorite.id,
        name: favoriteLabel(favorite),
        favorite,
      })),
    [favorites],
  );

  const currentIndex = useMemo(() => {
    return sessions.findIndex(({ favorite }) => {
      if (favorite.kind === "terminal") {
        return favorite.targetKey === activeSessionName;
      }
      return Boolean(activeClonePath) && favorite.relativePath === activeClonePath;
    });
  }, [activeClonePath, activeSessionName, sessions]);

  const current = currentIndex >= 0 ? sessions[currentIndex] : null;
  const previous = currentIndex > 0 ? sessions[currentIndex - 1] : null;
  const next =
    currentIndex >= 0 && currentIndex < sessions.length - 1 ? sessions[currentIndex + 1] : null;
  const favoritesById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  const select = useCallback(
    (favoriteId: string) => {
      const session = favoritesById.get(favoriteId);
      if (!session) return false;

      const { favorite } = session;
      if (favorite.kind === "terminal") {
        router.replace(favoriteHref(workspaceId, favorite.targetKey, debugViewportEnabled));
        return true;
      }

      if (!favorite.relativePath) return false;

      void resolveGitCloneTerminalAction({
        workspaceId: favorite.workspaceId,
        cloneSessionKey: favorite.targetKey,
        relativePath: favorite.relativePath,
      })
        .then((result) => {
          if (result?.data) {
            router.push(gitFavoriteHref(favorite.workspaceId, result.data, debugViewportEnabled));
            return;
          }
          setError(result?.serverError ?? "Failed to open favorite window");
        })
        .catch((selectError) => {
          setError(
            selectError instanceof Error ? selectError.message : "Failed to open favorite window",
          );
        });

      return true;
    },
    [debugViewportEnabled, favoritesById, router, workspaceId],
  );

  const reload = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  return {
    sessions,
    current,
    previous,
    next,
    canGoPrevious: previous !== null,
    canGoNext: next !== null,
    loading,
    error,
    reload,
    select,
  };
}
