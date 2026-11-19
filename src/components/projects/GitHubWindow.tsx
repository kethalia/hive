"use client";

import { useQuery } from "@tanstack/react-query";
import { BookMarked, Link2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PanelTabs, type PanelTabsNavigation } from "@/components/ui/panel-tabs";
import { WorkspacePicker } from "@/components/workspaces/WorkspacePicker";
import type { CoderWorkspace } from "@/lib/coder/types";
import { ProjectBrowser } from "./ProjectBrowser";

type Connection = { connected: boolean; login: string | null; authorizeUrl: string | null };
type Attempt = {
  attempt: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  interval: number;
};
async function connectionRequest<T>(body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/github/connection", {
    cache: "no-store",
    signal,
    ...(body && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new Error("GitHub connection unavailable");
  return response.json();
}
const sections = [
  { id: "connection", label: "Connection", icon: <Link2 /> },
  { id: "repositories", label: "Repositories", icon: <BookMarked /> },
] as const;

export function GitHubWindow({
  userId,
  workspaces,
  workspace,
  onWorkspaceChange,
  visible,
  navigation,
}: {
  userId: string;
  workspaces: CoderWorkspace[];
  workspace?: CoderWorkspace;
  onWorkspaceChange: (id: string) => void;
  visible: boolean;
  navigation: PanelTabsNavigation;
}) {
  const picker = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<"connection" | "repositories">("connection");
  const [pending, setPending] = useState<Attempt | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");
  const { data, status, isFetching, refetch } = useQuery({
    queryKey: ["github-connection", userId],
    queryFn: ({ signal }) => connectionRequest<Connection>(undefined, signal),
    enabled: visible && section === "connection" && !pending,
    retry: false,
    refetchOnWindowFocus: "always",
  });
  async function start() {
    setNotice("");
    setStarting(true);
    try {
      setPending(await connectionRequest<Attempt>({ action: "start" }));
    } catch {
      setNotice("Could not start GitHub sign-in. Try again.");
    } finally {
      setStarting(false);
    }
  }
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let interval = pending.interval * 1000;
    function finish(message: string) {
      setNotice(message);
      setPending(null);
      void refetch();
    }
    async function poll() {
      if (!pending || controller.signal.aborted) return;
      if (Date.now() >= pending.expiresAt) {
        finish("The sign-in code expired. Start again for a new code.");
        return;
      }
      try {
        const { state } = await connectionRequest<{
          state: "pending" | "approved" | "slow_down" | "expired" | "denied";
        }>({ action: "poll", attempt: pending.attempt }, controller.signal);
        if (controller.signal.aborted) return;
        if (state === "approved") {
          finish("GitHub sign-in complete.");
          return;
        }
        if (state === "expired" || state === "denied") {
          finish(
            state === "expired"
              ? "The sign-in code expired."
              : "GitHub authorization was declined.",
          );
          return;
        }
        if (state === "slow_down") interval += 5000;
      } catch {
        if (controller.signal.aborted) return;
        setNotice("Waiting to reach Coder. Hive will retry.");
      }
      timer = setTimeout(poll, Math.min(interval, Math.max(0, pending.expiresAt - Date.now())));
    }
    timer = setTimeout(poll, interval);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pending, refetch]);
  return (
    <PanelTabs
      label="GitHub"
      items={sections}
      value={section}
      onChange={setSection}
      navigation={navigation}
      busy={starting || !!pending}
    >
      {section === "repositories" ? (
        <div ref={picker} className="space-y-4">
          <WorkspacePicker
            label="Repository workspace"
            workspaces={workspaces}
            selected={workspace?.id}
            onSelect={onWorkspaceChange}
          />
          {workspace?.latest_build.status === "running" ? (
            <ProjectBrowser
              key={workspace.latest_build.id}
              workspaceId={workspace.id}
              enabled
              visible={visible}
              onSetup={(kind) => {
                if (kind === "account") setSection("connection");
                else picker.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
              }}
            />
          ) : (
            <p role="status">Choose a running Coder workspace to browse its GitHub repositories.</p>
          )}
        </div>
      ) : (
        <section className="space-y-4" aria-label="GitHub connection">
          <h2 className="font-semibold">GitHub connection</h2>
          {pending ? (
            <>
              <p>Enter this code on GitHub to authorize your Coder account.</p>
              <p className="select-all rounded-md border p-3 text-center font-mono text-xl tracking-wider">
                {pending.userCode}
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  className={buttonVariants()}
                  href={pending.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open GitHub ↗
                </a>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPending(null);
                    setNotice("Sign-in cancelled.");
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p role="status">
                Waiting for GitHub approval. Code expires at{" "}
                {new Date(pending.expiresAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                .
              </p>
            </>
          ) : (
            <>
              <p role="status">
                {status === "pending"
                  ? "Checking GitHub connection…"
                  : status === "error"
                    ? "Could not check your GitHub connection."
                    : data.connected
                      ? data.login
                        ? `Connected as @${data.login}`
                        : "GitHub connected"
                      : "GitHub is disconnected"}
              </p>
              <p className="text-sm text-muted-foreground">
                This connection is shared by your Coder workspaces.
              </p>
              <div className="flex flex-wrap gap-2">
                {status === "success" &&
                  (data.authorizeUrl ? (
                    <a
                      className={buttonVariants()}
                      href={data.authorizeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {data.connected ? "Reconnect GitHub" : "Connect GitHub"} ↗
                    </a>
                  ) : (
                    <Button disabled={starting} onClick={start}>
                      {starting
                        ? "Starting sign-in…"
                        : data.connected
                          ? "Reconnect GitHub"
                          : "Connect GitHub"}
                    </Button>
                  ))}
                <Button
                  variant="outline"
                  disabled={isFetching || starting}
                  onClick={() => {
                    setNotice("");
                    void refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" />
                  Refresh status
                </Button>
              </div>
            </>
          )}
          {notice && <p role="status">{notice}</p>}
        </section>
      )}
    </PanelTabs>
  );
}
