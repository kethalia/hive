"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useProjectConversation } from "@/hooks/useProjectConversation";
import {
  projectErrorCodeSchema,
  projectErrorMessages,
  type RepositoryProject,
} from "@/lib/projects/contracts";
import { type OpenedProject, openedProjectSchema } from "@/lib/projects/session-contracts";
import { type ProjectTaskStatus, projectTaskStatusSchema } from "@/lib/projects/task-contracts";
import { ConversationView } from "./ConversationView";
import { ProjectBrowser } from "./ProjectBrowser";

const ProjectTerminal = dynamic(() => import("./ProjectTerminal").then((m) => m.ProjectTerminal), {
  ssr: false,
});
async function post(path: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const code = projectErrorCodeSchema.safeParse(
      result && typeof result === "object" && "error" in result ? result.error : null,
    );
    throw new Error(
      code.success
        ? projectErrorMessages[code.data]
        : response.status === 409
          ? "The project changed. Reopen it before starting a task."
          : "The request could not be completed. You can retry safely.",
    );
  }
  return result;
}
const labels = {
  awaitingTask: "Ready for a task",
  preparing: "Preparing project",
  awaitingRegistration: "Connecting project",
  awaitingFirstPrompt: "Starting task",
  running: "Task running",
  blocked: "Task needs attention",
};
export function ProjectWorkspacePanel({
  workspaceId,
  visible,
  enabled,
  tasksEnabled,
}: {
  workspaceId: string;
  visible: boolean;
  enabled: boolean;
  tasksEnabled: boolean;
}) {
  const [selected, setSelected] = useState<OpenedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      ++sequence.current;
      controller.current?.abort();
    },
    [],
  );
  const open = async (repository: RepositoryProject, providerAccountId: string) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = openedProjectSchema.parse(
        await post(
          "/api/projects/open",
          {
            workspaceId,
            repositoryId: repository.providerRepositoryId,
            providerAccountId,
            requestId: crypto.randomUUID(),
          },
          request.signal,
        ),
      );
      if (
        result.workspaceId !== workspaceId ||
        result.repository.providerRepositoryId !== repository.providerRepositoryId ||
        result.providerAccountId !== providerAccountId
      )
        throw new Error("Project access changed. Refresh the repository list.");
      if (current === sequence.current) setSelected(result);
    } catch (e) {
      if (!request.signal.aborted && current === sequence.current)
        setError(
          e instanceof Error && e.name === "Error" ? e.message : "Could not open this project.",
        );
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  if (selected)
    return (
      <ProjectSession
        key={selected.projectId}
        project={selected}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <>
      {loading ? (
        <p role="status" className="px-4 text-sm">
          Opening project…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ProjectBrowser
        workspaceId={workspaceId}
        visible={visible}
        enabled={enabled}
        onSelectProject={
          tasksEnabled ? (project, account) => void open(project, account) : undefined
        }
      />
    </>
  );
}
function ProjectSession({ project, onBack }: { project: OpenedProject; onBack: () => void }) {
  const [text, setText] = useState("");
  const [task, setTask] = useState<ProjectTaskStatus | null>(
    project.currentTaskId
      ? {
          schemaVersion: 1,
          projectId: project.projectId,
          taskId: project.currentTaskId,
          phase: project.phase,
          nativeThreadId: project.nativeThreadId,
          terminalSessionName: project.terminalSessionName,
          reason: null,
        }
      : null,
  );
  const [mode, setMode] = useState<"conversation" | "terminal">("conversation");
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollGeneration, setPollGeneration] = useState(0);
  const textId = useId();
  const intent = useRef<{ text: string; requestId: string } | null>(null);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const nativeThreadId = task?.nativeThreadId ?? project.nativeThreadId;
  const terminalName = task?.terminalSessionName ?? project.terminalSessionName;
  const readable = Boolean(
    nativeThreadId && ((task?.phase ?? project.phase) === "running" || terminalName),
  );
  const { view, reconnect } = useProjectConversation(project.projectId, readable);
  const taskId = task?.taskId;
  const preparing = Boolean(task && !["running", "blocked"].includes(task.phase));
  // biome-ignore lint/correctness/useExhaustiveDependencies: pollGeneration deliberately restarts the bounded status loop.
  useEffect(() => {
    if (!taskId || !preparing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const request = new AbortController();
    const refresh = async () => {
      try {
        const result = projectTaskStatusSchema.parse(
          await post(
            `/api/projects/${project.projectId}/tasks/status`,
            {
              workspaceId: project.workspaceId,
              taskId,
              requestId: crypto.randomUUID(),
            },
            request.signal,
          ),
        );
        if (result.projectId !== project.projectId || result.taskId !== taskId)
          throw new Error("Project status changed. Reopen the project.");
        if (disposed) return;
        setTask(result);
        if (["running", "blocked"].includes(result.phase)) return;
        if (++attempts >= 20) {
          setError(
            "Preparation is taking longer than expected. Refresh its status to continue watching.",
          );
          return;
        }
        timer = setTimeout(() => void refresh(), 3000);
      } catch {
        if (!disposed)
          setError(
            "Could not refresh the task. Its workspace continues running; refresh its status to reconnect.",
          );
      }
    };
    void refresh();
    return () => {
      disposed = true;
      request.abort();
      clearTimeout(timer);
    };
  }, [project.projectId, project.workspaceId, taskId, preparing, pollGeneration]);
  const start = async () => {
    if (busy || !text.trim()) return;
    if (new TextEncoder().encode(text.trim()).length > 32768) {
      setError("Please shorten the task description.");
      return;
    }
    if (!intent.current || intent.current.text !== text)
      intent.current = { text, requestId: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const result = projectTaskStatusSchema.parse(
        await post(
          `/api/projects/${project.projectId}/tasks/start`,
          {
            workspaceId: project.workspaceId,
            requestId: intent.current.requestId,
            expectedRevision: project.defaultRevision,
            text,
          },
          lifetime.current.signal,
        ),
      );
      if (result.projectId !== project.projectId) throw new Error("Project identity changed.");
      if (!lifetime.current.signal.aborted) setTask(result);
    } catch (e) {
      if (!lifetime.current.signal.aborted)
        setError(
          e instanceof Error && e.name === "Error" ? e.message : "Could not start the task.",
        );
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  return (
    <section
      aria-label={`Project ${project.repository.fullName}`}
      className="flex min-h-96 flex-col gap-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Projects
        </Button>
        <h2 className="break-all font-medium">{project.repository.fullName}</h2>
        <span role="status" className="text-xs text-muted-foreground">
          {labels[task?.phase ?? project.phase]}
        </span>
      </header>
      {error ? (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          <span>{error}</span>
          {task ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                setPollGeneration((n) => n + 1);
              }}
            >
              Refresh status
            </Button>
          ) : null}
        </div>
      ) : null}
      {!task && !nativeThreadId ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label htmlFor={textId} className="text-sm font-medium">
            What do you need?
          </label>
          <Textarea
            id={textId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Describe the fix, feature, or performance improvement and how you’ll know it works."
            rows={5}
            disabled={busy}
          />
          <Button
            type="submit"
            disabled={
              busy ||
              !text.trim() ||
              project.repository.archived ||
              project.repository.permissions.push !== true
            }
          >
            {busy ? "Starting…" : "Start task"}
          </Button>
          {project.repository.archived || project.repository.permissions.push !== true ? (
            <p className="text-sm text-muted-foreground">
              Write access to an active repository is required to start work.
            </p>
          ) : null}
        </form>
      ) : null}
      {task?.phase === "blocked" ? (
        <p role="alert" className="text-sm">
          The task needs attention. Its session and work are preserved.
        </p>
      ) : null}
      {nativeThreadId ? (
        <>
          <fieldset className="flex gap-2">
            <legend className="sr-only">Project views</legend>
            <Button
              variant={mode === "conversation" ? "secondary" : "ghost"}
              onClick={() => setMode("conversation")}
            >
              Conversation
            </Button>
            <Button
              variant={mode === "terminal" ? "secondary" : "ghost"}
              disabled={!terminalName}
              onClick={() => {
                setTerminalOpened(true);
                setMode("terminal");
              }}
            >
              Terminal
            </Button>
          </fieldset>
          <div className={mode === "conversation" ? "h-[60vh] min-h-80" : "hidden"}>
            <ConversationView
              sessionKey={nativeThreadId}
              view={view}
              onReconnect={reconnect}
              onOpenTerminal={() => {
                if (terminalName) {
                  setTerminalOpened(true);
                  setMode("terminal");
                }
              }}
            />
          </div>
          {terminalName && terminalOpened ? (
            <div className={mode === "terminal" ? "h-[60vh] min-h-80" : "hidden"}>
              <ProjectTerminal projectId={project.projectId} visible={mode === "terminal"} />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
