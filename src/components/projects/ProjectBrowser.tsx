"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingStatus } from "@/components/ui/loading-status";
import { useProjectRepositories } from "@/hooks/useProjectRepositories";
import type { RepositoryProject } from "@/lib/projects/contracts";

type SelectProject = (repository: RepositoryProject, providerAccountId: string) => void;

export function ProjectBrowser({
  workspaceId,
  enabled = false,
  visible = true,
  onSetup,
  onSelectProject,
}: {
  workspaceId: string;
  enabled?: boolean;
  visible?: boolean;
  onSetup?: (kind: "workspace" | "account") => void;
  onSelectProject?: SelectProject;
}) {
  if (!enabled)
    return <p className="p-4 text-sm text-muted-foreground">Project discovery is not enabled.</p>;
  if (!visible) return null;
  return (
    <RepositoryBrowser
      key={workspaceId}
      workspaceId={workspaceId}
      onSetup={onSetup}
      onSelectProject={onSelectProject}
    />
  );
}

function RepositoryBrowser({
  workspaceId,
  onSetup,
  onSelectProject,
}: {
  workspaceId: string;
  onSetup?: (kind: "workspace" | "account") => void;
  onSelectProject?: SelectProject;
}) {
  const { snapshot, load } = useProjectRepositories(workspaceId, true);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const accountId = snapshot.providerAccountId;
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
              {onSelectProject && accountId ? (
                <Button
                  variant="link"
                  className="h-auto whitespace-normal break-all p-0 text-left"
                  disabled={!!snapshot.error || repository.permissions.pull !== true}
                  onClick={() => onSelectProject(repository, accountId)}
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
