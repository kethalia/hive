"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingStatus } from "@/components/ui/loading-status";
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

interface ProjectBrowserProps {
  workspaceId: string;
  enabled?: boolean;
  visible?: boolean;
  onSelectProject?: (project: RepositoryProject, providerAccountId: string) => void;
  onSetup?: (kind: "workspace" | "account") => void;
}
interface Snapshot {
  workspaceId: string;
  repositories: RepositoryProject[];
  nextPage: number | null;
  loading: "refresh" | "more" | null;
  loaded: boolean;
  error: string | null;
  setup: "workspace" | "account" | null;
}
const empty = (workspaceId: string): Snapshot => ({
  workspaceId,
  repositories: [],
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

/** Read-only and unmounted by default until its transport capability gate passes. */
export function ProjectBrowser({
  workspaceId,
  enabled = false,
  visible = true,
  onSelectProject,
  onSetup,
}: ProjectBrowserProps) {
  const [state, setState] = useState<Snapshot>(() => empty(workspaceId));
  const [query, setQuery] = useState("");
  const searchId = useId();
  const loadedPages = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const account = useRef<string | null>(null);
  const active = enabled && visible;

  const load = useCallback(
    async (page = 1) => {
      if (!active || controller.current) return;
      const request = new AbortController();
      controller.current = request;
      setState((previous) => ({
        ...(previous.workspaceId === workspaceId ? previous : empty(workspaceId)),
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
            (page === 1 || previous.workspaceId !== workspaceId ? [] : previous.repositories).map(
              (repository) => [repository.providerRepositoryId, repository],
            ),
          );
          for (const [id, repository] of refreshed) repositories.set(id, repository);
          return {
            workspaceId,
            repositories: [...repositories.values()],
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
            previous.workspaceId === workspaceId && previous.loaded && !problem?.deniesCachedData;
          return {
            ...(confirmed ? previous : empty(workspaceId)),
            loading: null,
            setup: confirmed ? null : (problem?.setup ?? "workspace"),
            error: message,
          };
        });
      } finally {
        if (controller.current === request) controller.current = null;
      }
    },
    [active, workspaceId],
  );

  useEffect(() => {
    account.current = null;
    loadedPages.current = 0;
    setState(empty(workspaceId));
    setQuery("");
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
  }, [workspaceId, active, load]);

  if (!enabled)
    return <p className="p-4 text-sm text-muted-foreground">Project discovery is not enabled.</p>;
  if (!visible) return null;
  const snapshot = state.workspaceId === workspaceId ? state : empty(workspaceId);
  const search = query.trim().toLocaleLowerCase();
  const repositories = snapshot.repositories.filter((repository) =>
    repository.fullName.toLocaleLowerCase().includes(search),
  );

  if (!snapshot.loaded && !snapshot.error)
    return <LoadingStatus>Loading repositories…</LoadingStatus>;
  return (
    <section aria-label="GitHub projects" className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {snapshot.repositories.length} repositories loaded
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={!!snapshot.loading}
          onClick={() => void load()}
        >
          {snapshot.loading === "refresh" ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <label htmlFor={searchId} className="text-sm font-medium">
        Search loaded repositories
      </label>
      <Input
        id={searchId}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Owner or repository name"
      />

      {snapshot.error ? (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error}
          {snapshot.loaded && " Showing the last confirmed repositories."}
        </p>
      ) : null}
      {snapshot.error && onSetup ? (
        <Button variant="outline" onClick={() => onSetup(snapshot.setup ?? "workspace")}>
          {snapshot.setup === "account" ? "Manage GitHub connection" : "Review workspace setup"}
        </Button>
      ) : null}
      {snapshot.loaded && !snapshot.loading && repositories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search
            ? "No loaded repositories match this search."
            : "No repositories available through this GitHub connection."}
        </p>
      ) : null}
      <ul className="space-y-2" aria-label="Repositories">
        {repositories.map((repository) => (
          <li key={repository.providerRepositoryId} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {onSelectProject ? (
                <Button
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => {
                    if (account.current) onSelectProject(repository, account.current);
                  }}
                >
                  {repository.fullName}
                </Button>
              ) : (
                <a
                  className="break-all font-medium underline"
                  href={repository.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {repository.fullName}
                </a>
              )}
              <span className="text-xs text-muted-foreground">
                {repository.archived ? "Archived" : repository.private ? "Private" : "Public"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {repository.permissions.push === true
                ? "Write access"
                : repository.permissions.pull === true
                  ? "Read access"
                  : "Access details unavailable"}
            </p>
            <details name={searchId} className="mt-2 text-sm">
              <summary className="cursor-pointer">Repository details</summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3">
                <dt>GitHub repository ID</dt>
                <dd>{repository.providerRepositoryId}</dd>
                <dt>Default branch</dt>
                <dd className="break-all">{repository.defaultBranch}</dd>
              </dl>
            </details>
          </li>
        ))}
      </ul>
      {snapshot.nextPage !== null ? (
        <Button
          variant="outline"
          disabled={!!snapshot.loading}
          onClick={() => void load(snapshot.nextPage ?? 1)}
        >
          {snapshot.loading === "more" ? "Loading more repositories…" : "Load more repositories"}
        </Button>
      ) : null}
    </section>
  );
}
