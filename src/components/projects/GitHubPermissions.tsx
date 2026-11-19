"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type AccessLevel, type PermissionView, permissionView } from "@/lib/projects/permissions";

const levels: { value: AccessLevel; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
];

export function GitHubPermissions({
  workspaceId,
  workspaceName,
  userId,
}: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
}) {
  const key = ["github-permissions", userId, workspaceId];
  const client = useQueryClient();
  const [saving, setSaving] = useState<number | null>(null);
  const [failure, setFailure] = useState("");
  async function request(
    change?: { repoId: number; access: AccessLevel; revision: string | null },
    signal?: AbortSignal,
  ) {
    const result = await fetch("/api/github/permissions", {
      method: "POST",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, change }),
    });
    if (!result.ok)
      throw new Error(
        result.status === 409
          ? "Permissions changed. Refresh and try again."
          : "Could not confirm repository access. Refresh to try again.",
      );
    return permissionView.parse(await result.json());
  }
  const { data, error, isPending, refetch } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => request(undefined, signal),
    retry: false,
  });
  async function change(repo: PermissionView["repositories"][number], access: AccessLevel) {
    setSaving(repo.id);
    setFailure("");
    try {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData(key, await request({ repoId: repo.id, revision: repo.revision, access }));
      toast.success("Repository access updated.");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not update permissions.");
    } finally {
      setSaving(null);
    }
  }
  return (
    <section className="space-y-4" aria-label="Workspace repository permissions">
      <h2 className="font-semibold">Repository permissions</h2>
      {isPending && <p role="status">Loading permissions…</p>}
      {(error || failure) && (
        <div role="alert">
          <p>{failure || error?.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFailure("");
              void refetch();
            }}
          >
            Refresh
          </Button>
        </div>
      )}
      {data?.managed === false && (
        <p>
          This workspace uses a personal GitHub login. Repository limits require a workspace
          configured with the Hive GitHub App.
        </p>
      )}
      {data?.managed && (
        <>
          <p className="text-sm text-muted-foreground">
            Choose which repositories {workspaceName} can read or push to through Hive, Git, and the
            GitHub CLI.
          </p>
          <ul className="divide-y rounded-md border">
            {data.repositories.map((repo) => (
              <li key={repo.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <label htmlFor={workspaceId + repo.id} className="min-w-0 break-all text-sm">
                  {repo.name}
                </label>
                <Select
                  items={levels}
                  disabled={saving !== null}
                  value={repo.access}
                  onValueChange={(value) => {
                    if (value) void change(repo, value);
                  }}
                >
                  <SelectTrigger size="sm" id={workspaceId + repo.id} aria-label={repo.name}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map((level) => (
                      <SelectItem key={level.value} value={level.value}>
                        {level.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
