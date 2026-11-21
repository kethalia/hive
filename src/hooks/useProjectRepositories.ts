import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ProjectPage,
  projectErrorCodeSchema,
  projectErrorMessages,
  projectPageSchema,
  type RepositoryProject,
} from "@/lib/projects/contracts";

class ProjectBrowserError extends Error {
  constructor(
    message: string,
    readonly setup: "workspace" | "account" = "workspace",
    readonly deniesCachedData = false,
  ) {
    super(message);
  }
}

interface Snapshot {
  scope: string;
  repositories: RepositoryProject[];
  providerAccountId: string | null;
  nextPage: number | null;
  loading: "refresh" | "more" | null;
  loaded: boolean;
  error: string | null;
  setup: "workspace" | "account" | null;
}
const empty = (scope: string): Snapshot => ({
  scope,
  repositories: [],
  providerAccountId: null,
  nextPage: null,
  loading: null,
  loaded: false,
  error: null,
  setup: null,
});

async function fetchRepositoryPage(workspaceId: string, page: number, signal: AbortSignal) {
  const params = new URLSearchParams({ workspaceId, page: String(page), perPage: "100" });
  const response = await fetch(`/api/projects?${params}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.redirected) {
    throw new ProjectBrowserError("Sign in to refresh repositories.", "workspace", true);
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = projectErrorCodeSchema.safeParse(
      value && typeof value === "object" && "error" in value ? value.error : null,
    );
    const reconnect =
      code.success && ["github_auth_required", "github_permission_denied"].includes(code.data);
    throw new ProjectBrowserError(
      code.success
        ? projectErrorMessages[code.data]
        : "Could not load repositories. Refresh to try again.",
      reconnect ? "account" : "workspace",
      reconnect ||
        [401, 403, 404, 409].includes(response.status) ||
        (code.success && ["workspace_forbidden", "discovery_disabled"].includes(code.data)),
    );
  }
  const result = projectPageSchema.parse(value);
  if (result.page !== page || result.perPage !== 100)
    throw new ProjectBrowserError("Invalid repository page.");
  return result;
}

export function useProjectRepositories(workspaceId: string, active: boolean, buildId?: string) {
  const scope = JSON.stringify([workspaceId, buildId]);
  const [state, setState] = useState<Snapshot>(() => empty(scope));
  const loadedPages = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const account = useRef<string | null>(null);

  const load = useCallback(
    async (page = 1) => {
      if (!active || controller.current) return;
      const request = new AbortController();
      controller.current = request;
      setState((previous) => ({
        ...(previous.scope === scope ? previous : empty(scope)),
        loading: page === 1 ? "refresh" : "more",
        error: null,
      }));
      try {
        const refreshed = new Map<string, RepositoryProject>();
        const lastPage = page === 1 ? Math.max(1, loadedPages.current) : page;
        let expectedAccount = account.current;
        let result: ProjectPage;
        for (let current = page; ; current++) {
          result = await fetchRepositoryPage(workspaceId, current, request.signal);
          if (request.signal.aborted) return;
          if (expectedAccount !== null && expectedAccount !== result.providerAccountId)
            throw new ProjectBrowserError(
              "GitHub account changed. Refresh to load its repositories.",
              "account",
              true,
            );
          expectedAccount = result.providerAccountId;
          for (const repository of result.repositories)
            refreshed.set(repository.providerRepositoryId, repository);
          if (current >= lastPage || result.nextPage === null) break;
        }
        account.current = result.providerAccountId;
        loadedPages.current = result.page;
        const nextPage = result.nextPage;
        setState((previous) => {
          const repositories = new Map(
            (page === 1 || previous.scope !== scope ? [] : previous.repositories).map(
              (repository) => [repository.providerRepositoryId, repository],
            ),
          );
          for (const [id, repository] of refreshed) repositories.set(id, repository);
          return {
            scope,
            repositories: [...repositories.values()],
            providerAccountId: expectedAccount,
            nextPage,
            loading: null,
            loaded: true,
            error: null,
            setup: null,
          };
        });
      } catch (error) {
        if (request.signal.aborted) return;
        const problem = error instanceof ProjectBrowserError ? error : null;
        const message = problem?.message ?? "Could not load repositories. Refresh to try again.";
        if (problem?.deniesCachedData) {
          loadedPages.current = 0;
          account.current = null;
        }
        setState((previous) => {
          const confirmed =
            previous.scope === scope && previous.loaded && !problem?.deniesCachedData;
          return {
            ...(confirmed ? previous : empty(scope)),
            loading: null,
            setup: confirmed ? null : (problem?.setup ?? "workspace"),
            error: message,
          };
        });
      } finally {
        if (controller.current === request) controller.current = null;
      }
    },
    [active, scope, workspaceId],
  );

  useEffect(() => {
    account.current = null;
    loadedPages.current = 0;
    setState(empty(scope));
    if (!active) return;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      controller.current?.abort();
      controller.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [scope, active, load]);

  return {
    snapshot: state.scope === scope ? state : empty(scope),
    load,
  };
}
