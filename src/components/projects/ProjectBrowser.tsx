"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  projectErrorCodeSchema,
  projectErrorMessages,
  projectPageSchema,
  type RepositoryProject,
} from "@/lib/projects/contracts";

class ProjectBrowserError extends Error {}

interface ProjectBrowserProps {
  workspaceId: string;
  enabled?: boolean;
  visible?: boolean;
  onSelectProject?: (project: RepositoryProject, providerAccountId: string) => void;
}
interface Snapshot {
  workspaceId: string;
  repositories: RepositoryProject[];
  nextPage: number | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}
const empty = (workspaceId: string): Snapshot => ({
  workspaceId,
  repositories: [],
  nextPage: null,
  loading: false,
  loaded: false,
  error: null,
});

/** Read-only and unmounted by default until its transport capability gate passes. */
export function ProjectBrowser({
  workspaceId,
  enabled = false,
  visible = true,
  onSelectProject,
}: ProjectBrowserProps) {
  const [state, setState] = useState<Snapshot>(() => empty(workspaceId));
  const [query, setQuery] = useState("");
  const searchId = useId();
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const account = useRef<string | null>(null);
  const active = enabled && visible;

  const load = useCallback(
    async (page = 1) => {
      if (!active) return;
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      const generation = ++sequence.current;
      if (page === 1) account.current = null;
      setState((previous) => ({
        ...(page === 1 || previous.workspaceId !== workspaceId ? empty(workspaceId) : previous),
        loading: true,
        error: null,
      }));
      try {
        const params = new URLSearchParams({ workspaceId, page: String(page), perPage: "100" });
        const response = await fetch(`/api/projects?${params}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: request.signal,
        });
        const value: unknown = await response.json();
        if (!response.ok) {
          const code = projectErrorCodeSchema.safeParse(
            value && typeof value === "object" && "error" in value ? value.error : null,
          );
          throw new ProjectBrowserError(
            code.success
              ? projectErrorMessages[code.data]
              : "Could not load repositories. Refresh to try again.",
          );
        }
        const result = projectPageSchema.parse(value);
        if (result.page !== page || result.perPage !== 100)
          throw new ProjectBrowserError("Invalid repository page.");
        if (generation !== sequence.current || request.signal.aborted) return;
        if (page > 1 && account.current !== result.providerAccountId)
          throw new ProjectBrowserError(
            "GitHub account changed. Refresh to load its repositories.",
          );
        account.current = result.providerAccountId;
        setState((previous) => {
          const repositories = new Map(
            (page === 1 || previous.workspaceId !== workspaceId ? [] : previous.repositories).map(
              (repository) => [repository.providerRepositoryId, repository],
            ),
          );
          for (const repository of result.repositories)
            repositories.set(repository.providerRepositoryId, repository);
          return {
            workspaceId,
            repositories: [...repositories.values()],
            nextPage: result.nextPage,
            loading: false,
            loaded: true,
            error: null,
          };
        });
      } catch (error) {
        if (generation !== sequence.current || request.signal.aborted) return;
        account.current = null;
        // Revoke all visible/cached metadata on authorization, transport, or schema failure.
        setState({
          ...empty(workspaceId),
          error:
            error instanceof ProjectBrowserError
              ? error.message
              : "Could not load repositories. Refresh to try again.",
        });
      }
    },
    [active, workspaceId],
  );

  useEffect(() => {
    account.current = null;
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
      ++sequence.current;
      controller.current?.abort();
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

  return (
    <section aria-label="GitHub projects" className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {snapshot.repositories.length} repositories loaded
        </p>
        <Button variant="outline" size="sm" disabled={snapshot.loading} onClick={() => void load()}>
          Refresh
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
      {snapshot.loading ? (
        <p role="status" className="text-sm">
          Loading repositories…
        </p>
      ) : null}
      {snapshot.error ? (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error}
        </p>
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
          </li>
        ))}
      </ul>
      {snapshot.nextPage !== null ? (
        <Button
          variant="outline"
          disabled={snapshot.loading}
          onClick={() => void load(snapshot.nextPage ?? 1)}
        >
          Load more repositories
        </Button>
      ) : null}
    </section>
  );
}
