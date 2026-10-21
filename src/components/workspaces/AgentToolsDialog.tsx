"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  configureAgentToolsAction,
  inspectAgentToolsAction,
  resumeAgentSessionAction,
} from "@/lib/actions/agent-tools";
import { type AgentSession, type AgentToolsSnapshot, agentLabels } from "@/lib/agents/types";

const states: Record<AgentSession["state"], string> = {
  working: "Working",
  "needs-input": "Needs input",
  "needs-approval": "Needs approval",
  ready: "Ready",
  interrupted: "Interrupted",
  ended: "Ended",
  failed: "Failed",
  offline: "Not running",
};
const authLabels = {
  "signed-in": "Signed in",
  "signed-out": "Sign in needed",
  unknown: "Sign-in status unavailable",
};

interface AgentToolsDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSession: (sessionName: string) => void;
}

export function AgentToolsDialog({
  workspaceId,
  open,
  onOpenChange,
  onOpenSession,
}: AgentToolsDialogProps) {
  const [snapshot, setSnapshot] = useState<AgentToolsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const latest = useRef({ workspaceId, open });
  latest.current = { workspaceId, open };

  useEffect(() => {
    latest.current.open = open;
    return () => {
      latest.current.open = false;
    };
  }, [open]);

  useEffect(() => {
    void workspaceId;
    setSnapshot(null);
    setQuery("");
    setNotice(null);
    setPending(null);
  }, [workspaceId]);

  useEffect(() => {
    void refresh;
    const request = ++generation.current;
    if (!open) return;
    setLoading(true);
    setError(null);
    void inspectAgentToolsAction({ workspaceId })
      .then((result) => {
        if (generation.current !== request) return;
        if (result?.data) setSnapshot(result.data);
        else setError(result?.serverError ?? "Could not read agent tools. Refresh to try again.");
      })
      .catch(() => {
        if (generation.current === request)
          setError("Could not read agent tools. Refresh to try again.");
      })
      .finally(() => {
        if (generation.current === request) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [open, refresh, workspaceId]);

  async function configure(operation: "install" | "disable" | "configure-coder") {
    setPending(operation);
    setError(null);
    setNotice(null);
    const requestWorkspace = workspaceId;
    try {
      const result = await configureAgentToolsAction({ workspaceId, operation });
      if (latest.current.workspaceId !== requestWorkspace || !latest.current.open) return;
      if (!result?.data) throw new Error(result?.serverError ?? "Could not update agent tools.");
      setNotice(result.data.message);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (latest.current.workspaceId === requestWorkspace && latest.current.open) {
        setError(error instanceof Error ? error.message : "Could not update agent tools.");
      }
    } finally {
      if (latest.current.workspaceId === requestWorkspace) setPending(null);
    }
  }

  async function resume(session: AgentSession) {
    setPending(session.key);
    setError(null);
    const requestWorkspace = workspaceId;
    try {
      const result = await resumeAgentSessionAction({ workspaceId, key: session.key });
      if (latest.current.workspaceId !== requestWorkspace || !latest.current.open) return;
      if (!result?.data)
        throw new Error(result?.serverError ?? "Could not resume this conversation.");
      onOpenSession(result.data.sessionName);
      onOpenChange(false);
    } catch (error) {
      if (latest.current.workspaceId === requestWorkspace && latest.current.open) {
        setError(error instanceof Error ? error.message : "Could not resume this conversation.");
      }
    } finally {
      if (latest.current.workspaceId === requestWorkspace) setPending(null);
    }
  }

  const filtered =
    snapshot?.sessions.filter((session) =>
      `${agentLabels[session.agent]} ${session.project} ${session.directory} ${session.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    ) ?? [];
  const tracking = snapshot?.agents.every((agent) => agent.tracking);
  const coderConfigured = snapshot?.agents.every((agent) =>
    agent.connections.some((connection) => connection.name === "hive_coder"),
  );
  const typescriptPlugin = snapshot?.agents
    .find((agent) => agent.agent === "claude")
    ?.plugins.find((plugin) => plugin.name.startsWith("typescript-lsp@"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent tools and sessions</DialogTitle>
          <DialogDescription>
            Check your workspace setup and return to a conversation.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {loading
              ? "Checking workspace…"
              : snapshot
                ? `Checked ${new Date(snapshot.checkedAt * 1000).toLocaleTimeString()}`
                : "Workspace tools"}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || Boolean(pending)}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}{" "}
            Refresh
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm">
            {notice}
          </p>
        ) : null}
        <div
          className="min-h-0 space-y-5 overflow-y-auto overscroll-contain pr-1"
          data-mobile-scroll-allow="true"
        >
          {snapshot ? (
            <>
              <section aria-label="Agent setup" className="grid gap-3 sm:grid-cols-2">
                {snapshot.agents.map((agent) => (
                  <div key={agent.agent} className="min-w-0 space-y-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <h3 className="font-medium">{agentLabels[agent.agent]}</h3>
                      <span className="text-xs text-muted-foreground">
                        {agent.installed ? (agent.version ?? "Installed") : "Not installed"}
                      </span>
                    </div>
                    <p className="text-sm">{authLabels[agent.auth]}</p>
                    <p className="text-xs text-muted-foreground">
                      {agent.tracking
                        ? agent.agent === "codex"
                          ? "Tracking hooks installed · review trust in /hooks"
                          : "Tracking hooks installed · restart to activate"
                        : "Session tracking is off"}
                    </p>
                    <details>
                      <summary className="cursor-pointer text-sm">
                        Connections ({agent.connections.length}) and plugins ({agent.plugins.length}
                        )
                      </summary>
                      <ul className="mt-2 space-y-1 text-xs">
                        {agent.connections.map((connection) => (
                          <li key={connection.name} className="break-words">
                            {connection.name} · {connection.enabled ? "Configured" : "Disabled"}
                            {connection.auth === "not_logged_in" ? " · sign in needed" : ""}
                          </li>
                        ))}
                        {agent.plugins.map((plugin) => (
                          <li key={plugin.name} className="break-words">
                            {plugin.name} · {plugin.enabled ? "Installed" : "Disabled"}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs text-muted-foreground">
                        User-level inventory. Check /mcp in this agent for live connections and
                        project-specific tools.
                      </p>
                    </details>
                    {agent.warnings.map((warning) => (
                      <p key={warning} className="text-xs text-muted-foreground">
                        {warning}
                      </p>
                    ))}
                  </div>
                ))}
              </section>
              <section
                aria-label="Workspace integrations"
                className="space-y-3 rounded-lg border p-3"
              >
                <h3 className="font-medium">Workspace integrations</h3>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-sm">
                    <p>Coder inspection tools</p>
                    <p className="text-xs text-muted-foreground">
                      {snapshot.profile !== "software"
                        ? "Available in the software workspace."
                        : coderConfigured
                          ? "Configured for both agents. Check /mcp after restarting."
                          : "Workspace health, templates, apps, and logs."}
                    </p>
                  </div>
                  {snapshot.coderMcpSupported && !coderConfigured ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(pending)}
                      onClick={() => void configure("configure-coder")}
                    >
                      Connect Coder
                    </Button>
                  ) : null}
                  {snapshot.profile === "software" && !snapshot.coderMcpSupported ? (
                    <p className="text-xs text-muted-foreground">
                      Update Coder to a version with MCP tool allowlists.
                    </p>
                  ) : null}
                </div>
                <div className="text-sm">
                  <p>TypeScript code intelligence · Claude Code</p>
                  <p className="text-xs text-muted-foreground">
                    Language server:{" "}
                    {snapshot.typescriptServerInstalled ? "installed" : "not installed"}. Plugin:{" "}
                    {typescriptPlugin
                      ? typescriptPlugin.enabled
                        ? "installed"
                        : "disabled"
                      : "not installed"}
                    .
                  </p>
                  {!snapshot.typescriptServerInstalled || !typescriptPlugin ? (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer">Setup commands</summary>
                      <p className="mt-2">Run in a workspace terminal:</p>
                      <code className="mt-1 block break-words">
                        npm install -g typescript-language-server@5.1.3 typescript@5.9.3
                      </code>
                      <code className="mt-1 block break-words">
                        claude plugin install typescript-lsp@claude-plugins-official
                      </code>
                      <p className="mt-2 text-muted-foreground">
                        Restart Claude Code, then check /plugin for language-server errors.
                      </p>
                    </details>
                  ) : null}
                </div>
              </section>
              <section aria-label="Recent agent sessions" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">Recent conversations</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(pending)}
                    onClick={() => void configure(tracking ? "disable" : "install")}
                  >
                    {pending === "install"
                      ? "Installing…"
                      : tracking
                        ? "Disable tracking"
                        : "Enable tracking"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Tracking stores up to 200 session IDs, folders, and lifecycle events in this
                  workspace. Conversations appear after tracking is enabled and agents restart;
                  Codex also requires /hooks trust. Prompts and transcripts stay in the agent.
                  Status reflects its last event, not completion of the whole task.
                </p>
                <Input
                  aria-label="Search agent sessions"
                  placeholder="Search project, folder, agent, or session ID…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {filtered.length ? (
                  <ul className="space-y-2">
                    {filtered.map((session) => (
                      <li
                        key={session.key}
                        className="flex items-center gap-3 rounded-lg border p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {session.project} · {agentLabels[session.agent]}
                          </p>
                          <p className="break-words text-xs text-muted-foreground">
                            ~/{session.directory}
                          </p>
                          <p className="mt-1 text-xs">
                            {states[session.state]} ·{" "}
                            {new Date(session.updatedAt * 1000).toLocaleString()}
                          </p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {session.id.slice(0, 8)}
                          </p>
                          {!session.directoryExists ? (
                            <p className="text-xs text-destructive">
                              The conversation folder is unavailable.
                            </p>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            Boolean(pending) || (!session.running && !session.directoryExists)
                          }
                          onClick={() => void resume(session)}
                        >
                          {pending === session.key ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          {session.running ? "Open" : "Resume"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {query
                      ? "No conversations match your search."
                      : "No conversations recorded yet."}
                  </p>
                )}
              </section>
            </>
          ) : loading ? (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              Checking installed agents, connections, and recent sessions…
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
