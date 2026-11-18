"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  type CodexLibrary,
  type CodexLibrarySection,
  type CodexManagementRequest,
  codexManagementResponseSchema,
} from "@/lib/agents/codex-management-contracts";

type Page = { search: string | null; archived: boolean; cursor: string | null };
type Change = Pick<
  Extract<CodexManagementRequest, { action: "save-library" }>,
  "section" | "id" | "revision" | "change"
>;
const firstPage: Page = { search: null, archived: false, cursor: null };
const titles = {
  skills: "Skills",
  plugins: "Plugins",
  sessions: "Sessions",
  integrations: "Integrations",
};
const stateNames = {
  saved: "Saved",
  running: "Running",
  idle: "Idle",
  error: "Needs attention",
  unknown: "Unknown",
};
const authNames = {
  unknown: "Auth unknown",
  unsupported: "No OAuth",
  notLoggedIn: "Sign-in required",
  bearerToken: "Token configured",
  oAuth: "OAuth connected",
};
const runtimeNames = new Map([
  ["notStarted", "Not started"],
  ["starting", "Starting"],
  ["connected", "Connected"],
  ["authenticationRequired", "Sign-in required"],
  ["failed", "Connection failed"],
  ["cancelled", "Cancelled"],
  ["disabled", "Disabled"],
]);

export function CodexLibraryPanel({
  workspaceId,
  buildId,
  lifetimeId,
  generation,
  section,
  sessionId,
  onSessionSkills,
  onWorkspaceSkills,
  disabled,
  onBusyChange,
  onAccountRefresh,
  onGeneration,
}: {
  workspaceId: string;
  buildId: string;
  lifetimeId: string;
  generation: number;
  section: CodexLibrarySection;
  sessionId?: string;
  onSessionSkills: (id: string) => void;
  onWorkspaceSkills: () => void;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onAccountRefresh: () => void;
  onGeneration: (generation: number) => void;
}) {
  const [data, setData] = useState<CodexLibrary>();
  const [page, setPage] = useState(firstPage);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [search, setSearch] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<(Change & { name: string }) | null>(null);
  const active = useRef<AbortController | null>(null);
  const started = useRef(false);

  useEffect(
    () => () => {
      if (active.current) {
        active.current.abort();
        active.current = null;
        onBusyChange(false);
      }
      started.current = false;
    },
    [onBusyChange],
  );

  async function execute(
    operation: { page: Page; previous: Array<string | null> } | { change: Change },
  ) {
    if (disabled || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const saving = "change" in operation;
    const scope = sessionId ? { sessionId } : {};
    const request: CodexManagementRequest = saving
      ? { action: "save-library", lifetimeId, generation, ...scope, ...operation.change }
      : { action: "library", lifetimeId, generation, section, ...scope, ...operation.page };
    setBusy(saving ? operation.change.id : "read");
    setError("");
    setNotice("");
    onBusyChange(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/codex-management`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
          body: JSON.stringify({ buildId, request }),
        },
      );
      if (response.status === 404) {
        setError("Update this workspace’s Hive bridge to use this section.");
        return;
      }
      if (!response.ok) throw Error();
      const result = codexManagementResponseSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      if (
        result.lifetimeId !== lifetimeId ||
        result.generation !== generation + Number(saving) ||
        result.library?.section !== section ||
        (saving ? result.outcome === "read" : result.outcome !== "read")
      )
        throw Error();
      setData(result.library);
      if (saving) {
        onGeneration(result.generation);
        if (result.outcome === "unknown")
          setError("The result could not be confirmed. Refresh before making another change.");
        else setNotice("Change saved.");
      } else {
        setPage(operation.page);
        setPrevious(operation.previous);
      }
    } catch {
      if (controller.signal.aborted) return;
      setError(
        saving
          ? "The result could not be confirmed. Refresh before making another change."
          : "Could not load this section. Try refreshing.",
      );
      onAccountRefresh();
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(undefined);
        onBusyChange(false);
      }
    }
  }

  useEffect(() => {
    if (!started.current && !disabled) {
      started.current = true;
      void execute({ page: firstPage, previous: [] });
    }
  });

  const locked = disabled || busy !== undefined;
  const matching = (name: string, description = "") =>
    `${name} ${description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const canChange = !error && !locked;
  const showSearch = section !== "integrations" || Boolean(data?.rows.length);

  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={titles[section]}
      aria-busy={busy !== undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{titles[section]}</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => void execute({ page, previous })}
        >
          {busy === "read" ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>
      {section === "skills" && sessionId && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {data?.section === "skills" && <p className="min-w-0 break-all">{data.directory}</p>}
          <Button size="sm" variant="outline" disabled={locked} onClick={onWorkspaceSkills}>
            Workspace skills
          </Button>
        </div>
      )}
      {showSearch && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (section === "sessions")
              void execute({
                page: { search: search.trim() || null, archived: page.archived, cursor: null },
                previous: [],
              });
          }}
        >
          <Input
            type="search"
            placeholder={`Search ${section}`}
            aria-label={`Search ${section}`}
            className="min-w-0 flex-1 basis-32"
            value={search}
            maxLength={160}
            onChange={(event) => setSearch(event.target.value)}
          />
          {section === "sessions" && (
            <Button size="sm" variant="outline" type="submit" disabled={locked}>
              Search
            </Button>
          )}
          {section === "sessions" && (
            <Button
              size="sm"
              variant={page.archived ? "secondary" : "outline"}
              disabled={locked}
              aria-pressed={page.archived}
              onClick={() =>
                void execute({
                  page: {
                    ...page,
                    search: search.trim() || null,
                    archived: !page.archived,
                    cursor: null,
                  },
                  previous: [],
                })
              }
            >
              Archived
            </Button>
          )}
          {section === "plugins" && (
            <Button
              size="sm"
              variant={installedOnly ? "secondary" : "outline"}
              aria-pressed={installedOnly}
              onClick={() => setInstalledOnly(!installedOnly)}
            >
              Installed
            </Button>
          )}
        </form>
      )}
      {!data && busy && (
        <p role="status" className="text-muted-foreground">
          Loading {section}…
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data?.partial && (
        <p className="text-muted-foreground">Only part of this inventory is available.</p>
      )}
      {data?.section === "skills" && (
        <Rows
          rows={data.rows.filter((row) => matching(row.name, row.description))}
          empty="No matching skills."
          id={(row) => row.id}
        >
          {(row) => (
            <>
              <RowTitle
                name={row.name}
                detail={`${row.scope} · ${row.enabled ? "Enabled" : "Disabled"}`}
              />
              {row.description && (
                <p className="break-words text-muted-foreground">{row.description}</p>
              )}
              {row.pluginId && (
                <p className="break-words text-xs text-muted-foreground">
                  Provided by {row.pluginId}
                </p>
              )}
              {row.editable && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canChange}
                  onClick={() =>
                    void execute({
                      change: {
                        section: "skills",
                        id: row.id,
                        revision: row.revision,
                        change: row.enabled ? "disable" : "enable",
                      },
                    })
                  }
                >
                  {busy === row.id ? "Saving…" : row.enabled ? "Disable" : "Enable"}
                </Button>
              )}
            </>
          )}
        </Rows>
      )}
      {data?.section === "plugins" && (
        <Rows
          rows={data.rows.filter(
            (row) => (!installedOnly || row.installed) && matching(row.name, row.description),
          )}
          empty={
            data.rows.length
              ? "No matching plugins."
              : "No plugins are available from this Codex workspace’s marketplaces."
          }
          id={(row) => row.id}
        >
          {(row) => {
            const target = { section: "plugins" as const, id: row.id, revision: row.revision };
            return (
              <>
                <RowTitle
                  name={row.name}
                  detail={row.installed ? (row.enabled ? "Enabled" : "Disabled") : "Available"}
                />
                {(row.marketplace || row.version) && (
                  <p className="break-words text-xs text-muted-foreground">
                    {[row.marketplace, row.version].filter(Boolean).join(" · ")}
                  </p>
                )}
                {row.description && (
                  <p className="break-words text-muted-foreground">{row.description}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {row.installed && row.editable && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canChange}
                      onClick={() =>
                        void execute({
                          change: { ...target, change: row.enabled ? "disable" : "enable" },
                        })
                      }
                    >
                      {busy === row.id ? "Saving…" : row.enabled ? "Disable" : "Enable"}
                    </Button>
                  )}
                  {(row.installed ? row.editable : row.installable) && (
                    <Button
                      size="sm"
                      variant={row.installed ? "ghost" : "outline"}
                      disabled={!canChange}
                      onClick={() =>
                        setConfirm({
                          ...target,
                          change: row.installed ? "remove" : "install",
                          name: row.name,
                        })
                      }
                    >
                      {row.installed ? "Remove" : busy === row.id ? "Installing…" : "Install"}
                    </Button>
                  )}
                </div>
              </>
            );
          }}
        </Rows>
      )}
      {data?.section === "sessions" &&
        (data.rows.length === 0 ? (
          <p className="text-muted-foreground">
            No matching {page.archived ? "archived " : ""}sessions.
          </p>
        ) : (
          [...Map.groupBy(data.rows, (row) => row.directory)].map(([directory, sessions]) => (
            <div key={directory} className="space-y-2">
              <h3 className="break-all text-xs text-muted-foreground">
                {directory || "Unknown directory"}
              </h3>
              <Rows rows={sessions} empty="" id={(row) => row.id}>
                {(row) => (
                  <>
                    <RowTitle name={row.name} detail={stateNames[row.status]} />
                    {row.updatedAt !== null && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(row.updatedAt * 1000).toLocaleString()}
                      </p>
                    )}
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">
                        Session details
                      </summary>
                      {row.canInspectSkills && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2 h-auto min-h-10 whitespace-normal py-2"
                          disabled={locked}
                          onClick={() => onSessionSkills(row.id)}
                        >
                          Manage directory skills
                        </Button>
                      )}

                      <dl className="mt-2 space-y-1 break-all text-xs">
                        {row.model && (
                          <>
                            <dt className="text-muted-foreground">Model</dt>
                            <dd>{row.model}</dd>
                          </>
                        )}
                        <dt className="text-muted-foreground">Thread</dt>
                        <dd>{row.id}</dd>
                        {row.parent && (
                          <>
                            <dt className="text-muted-foreground">Parent thread</dt>
                            <dd>{row.parent}</dd>
                          </>
                        )}
                      </dl>
                    </details>
                  </>
                )}
              </Rows>
            </div>
          ))
        ))}
      {data?.section === "integrations" && (
        <Rows
          rows={data.rows.filter((row) => matching(row.name, row.pluginId ?? ""))}
          empty="No matching integrations."
          id={(row) => row.name}
        >
          {(row) => (
            <>
              <RowTitle name={row.name} detail={authNames[row.auth]} />
              {row.runtime && (
                <p className="text-xs text-muted-foreground">
                  {runtimeNames.get(row.runtime) ?? "Runtime status unknown"}
                </p>
              )}
              {row.pluginId && (
                <p className="break-words text-xs text-muted-foreground">
                  Provided by {row.pluginId}
                </p>
              )}
              {row.tools.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">Tools</summary>
                  <ul className="mt-2 space-y-1 break-all text-xs">
                    {[...new Set(row.tools)].map((tool) => (
                      <li key={tool}>{tool}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </Rows>
      )}
      {(previous.length > 0 || data?.nextCursor) && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={locked || previous.length === 0}
            onClick={() =>
              void execute({
                page: { ...page, cursor: previous.at(-1) ?? null },
                previous: previous.slice(0, -1),
              })
            }
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={locked || !data?.nextCursor}
            onClick={() => {
              if (data?.nextCursor)
                void execute({
                  page: { ...page, cursor: data.nextCursor },
                  previous: [...previous, page.cursor],
                });
            }}
          >
            Next
          </Button>
        </div>
      )}
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        {confirm && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="break-words">
                {confirm.change === "install" ? "Install" : "Remove"} {confirm.name}?
              </DialogTitle>
              <DialogDescription>
                This changes plugins for managed Codex in the selected workspace.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirm.change === "remove" ? "destructive" : "default"}
                disabled={!canChange}
                onClick={() => {
                  const { name: _name, ...change } = confirm;
                  setConfirm(null);
                  void execute({ change });
                }}
              >
                {confirm.change === "install" ? "Install plugin" : "Remove plugin"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

function RowTitle({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
      <p className="min-w-0 font-medium break-words">{name}</p>
      <p className="min-w-0 break-words text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function Rows<T>({
  rows,
  id,
  empty,
  children,
}: {
  rows: T[];
  id: (row: T) => string;
  empty: string;
  children: (row: T) => React.ReactNode;
}) {
  if (rows.length === 0) return <p className="text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y overflow-hidden rounded-md border">
      {rows.map((row) => (
        <li className="min-w-0 space-y-2 px-3 py-2.5" key={id(row)}>
          {children(row)}
        </li>
      ))}
    </ul>
  );
}
