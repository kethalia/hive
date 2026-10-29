"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type DeliveryReport,
  type DeliveryTaskDetail,
  deliveryTaskDetailSchema,
  deliveryTaskPageSchema,
} from "@/lib/delivery/read-contracts";

class DeliveryReadError extends Error {
  constructor(readonly status: number) {
    super("Delivery is unavailable.");
  }
}
async function read(url: string, signal: AbortSignal) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new DeliveryReadError(response.status);
  return response.json();
}
function errorMessage(error: Error | null) {
  if (error instanceof DeliveryReadError && error.status === 401)
    return "Sign in again to view delivery progress.";
  if (error instanceof DeliveryReadError && error.status === 404)
    return "This delivery item is unavailable.";
  return "Could not refresh delivery progress. Retry to load current information.";
}
const words = (value: string) => value.replaceAll("_", " ");

function StepReport({ report, selected }: { report: DeliveryReport; selected: boolean }) {
  return (
    <details
      id={`delivery-report-${report.id}`}
      open={selected || undefined}
      className="rounded-md border p-3 text-sm"
      data-selected={selected || undefined}
    >
      <summary className="cursor-pointer break-words font-medium">{report.summary}</summary>
      <div className="mt-3 space-y-3">
        <p>
          <strong>Difficulty: {report.difficulty}.</strong> {report.difficultyReason}
        </p>
        {report.issues.length ? (
          <ul className="list-disc space-y-2 pl-5">
            {report.issues.map((issue, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Published step reports are immutable, including issue ordering.
              <li key={`${index}:${issue.summary}`}>
                <p>{issue.summary}</p>
                <p className="text-muted-foreground">{issue.resolution}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>No issues reported.</p>
        )}
        {report.remainingUncertainty && (
          <p>
            <strong>Still uncertain:</strong> {report.remainingUncertainty}
          </p>
        )}
        <p>
          <strong>Next:</strong> {report.nextAction}
        </p>
        <div>
          <h4 className="font-medium">Evidence</h4>
          <ul className="mt-1 space-y-2">
            {report.evidence.map((evidence) => (
              <li key={evidence.id} className="rounded bg-muted p-2">
                <p>
                  {words(evidence.kind)} · {evidence.status}
                  {evidence.invalidatedAt ? " · invalidated" : ""}
                </p>
                <p>
                  {words(evidence.verificationMode)} · {evidence.environment} ·{" "}
                  <code>{evidence.sourceSha.slice(0, 12)}</code>
                </p>
                <time className="text-xs text-muted-foreground" dateTime={evidence.observedAt}>
                  {new Date(evidence.observedAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        </div>
        <time className="text-xs text-muted-foreground" dateTime={report.createdAt}>
          {new Date(report.createdAt).toLocaleString()}
        </time>
      </div>
    </details>
  );
}
function orderedSteps(steps: DeliveryTaskDetail["steps"]) {
  const remaining = [...steps];
  const result: typeof steps = [];
  const seen = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex((step) => step.dependencies.every((id) => seen.has(id)));
    if (index < 0) return [...result, ...remaining];
    const [step] = remaining.splice(index, 1);
    result.push(step);
    seen.add(step.id);
  }
  return result;
}
function TaskProgress({ task, reportId }: { task: DeliveryTaskDetail; reportId?: string }) {
  const reports = task.steps.flatMap((step) => step.reports);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!reportId || shown.current === reportId) return;
    const element = document.getElementById(`delivery-report-${reportId}`);
    if (element) {
      shown.current = reportId;
      element.scrollIntoView?.({ block: "nearest" });
    }
  }, [reportId]);
  return (
    <section aria-label="Task progress" className="min-w-0 space-y-4">
      <h2 className="break-words text-lg font-semibold">{task.outcome}</h2>
      <p className="break-words text-sm text-muted-foreground">
        {task.projectName} · {task.branch} · <code>{task.sourceSha.slice(0, 12)}</code>
      </p>
      {task.pauseRequested && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {task.schedulingPaused
            ? "Scheduling paused."
            : "Pause requested; current work is finishing."}
        </p>
      )}
      {reportId && !reports.some((report) => report.id === reportId) && (
        <p role="status" className="text-sm">
          The linked report is not available in this task’s recent history.
        </p>
      )}
      <ol className="space-y-4">
        {orderedSteps(task.steps).map((step) => (
          <li key={step.id} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium capitalize">{words(step.kind)}</h3>
              <span className="rounded bg-muted px-2 py-1 text-xs">{words(step.state)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {step.acceptancePhase === "activation_production"
                ? "Production verification"
                : "Implementation and preview"}{" "}
              · Attempt {step.attemptCount} of {step.attemptBudget}
            </p>
            {step.waitingReason && <p className="break-words text-sm">{step.waitingReason}</p>}
            {step.latestAttempt && (
              <p className="break-words text-xs text-muted-foreground">
                {step.latestAttempt.effectiveModel ?? "Model not recorded"} ·{" "}
                {step.latestAttempt.effectiveEffort ?? "Effort not recorded"}
                {step.latestAttempt.requestedModel &&
                step.latestAttempt.requestedModel !== step.latestAttempt.effectiveModel
                  ? ` (requested ${step.latestAttempt.requestedModel})`
                  : ""}
              </p>
            )}
            {step.reports.map((report) => (
              <StepReport key={report.id} report={report} selected={report.id === reportId} />
            ))}
          </li>
        ))}
      </ol>
      {task.recentEvents.length > 0 && (
        <section aria-label="Recent task activity" className="space-y-2">
          <h3 className="font-medium">Recent activity</h3>
          <ol className="space-y-2">
            {task.recentEvents.map((event) => (
              <li key={event.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">{event.label}</p>
                {event.reason && <p className="break-words">{event.reason}</p>}
                <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleString()}
                </time>
                {event.reportId && (
                  <a
                    className="ml-2 underline"
                    href={`/workspaces?panel=delivery&task=${task.id}&report=${event.reportId}`}
                  >
                    Open report
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
export function DeliveryPanel({
  userId,
  enabled = false,
  visible = true,
  taskId,
  reportId,
}: {
  userId: string;
  enabled?: boolean;
  visible?: boolean;
  taskId?: string;
  reportId?: string;
}) {
  const [selected, setSelected] = useState(taskId);
  useEffect(() => {
    setSelected(taskId);
  }, [taskId]);
  const active = enabled && visible;
  const tasks = useInfiniteQuery({
    queryKey: ["delivery-tasks", userId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      deliveryTaskPageSchema.parse(
        await read(
          `/api/delivery/tasks${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
          signal,
        ),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: active,
    retry: false,
    refetchInterval: active ? 15_000 : false,
    refetchOnWindowFocus: true,
    gcTime: 0,
  });
  const selectedReport = selected === taskId ? reportId : undefined;
  const detail = useQuery({
    queryKey: ["delivery-task", userId, selected, selectedReport],
    queryFn: async ({ signal }) =>
      deliveryTaskDetailSchema.parse(
        await read(
          `/api/delivery/tasks/${selected}${selectedReport ? `?report=${encodeURIComponent(selectedReport)}` : ""}`,
          signal,
        ),
      ),
    enabled: active && Boolean(selected),
    retry: false,
    refetchInterval: active ? 15_000 : false,
    refetchOnWindowFocus: true,
    gcTime: 0,
  });
  if (!enabled)
    return <p className="p-4 text-sm">Delivery tracking is not enabled for this instance.</p>;
  if (!visible) return null;
  const rows = [
    ...new Map(
      tasks.data?.pages.flatMap((page) => page.tasks).map((task) => [task.id, task]),
    ).values(),
  ];
  return (
    <div className="space-y-4 p-4" data-mobile-scroll-allow="true">
      <p className="text-sm text-muted-foreground">
        Track work and inspect step reports. Automatic production delivery is not enabled.
      </p>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Tasks</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void tasks.refetch();
            if (selected) void detail.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {tasks.isError ? (
        <p role="alert" className="text-sm">
          {errorMessage(tasks.error)}
        </p>
      ) : tasks.isPending ? (
        <p role="status">Loading tasks…</p>
      ) : (
        <>
          {!rows.length && (
            <p className="text-sm text-muted-foreground">
              No delivery tasks yet. Tasks created by your manager will appear here.
            </p>
          )}
          <ul className="space-y-2">
            {rows.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setSelected(task.id)}
                  aria-pressed={selected === task.id}
                  className="w-full rounded-md border p-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="block break-words text-sm font-medium">{task.outcome}</span>
                  <span className="block break-words text-xs text-muted-foreground">
                    {task.projectName} · {task.counts.succeeded}/{task.counts.total} steps complete
                    {task.counts.attention ? ` · ${task.counts.attention} need attention` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {tasks.hasNextPage && (
            <Button
              variant="outline"
              disabled={tasks.isFetchingNextPage}
              onClick={() => void tasks.fetchNextPage()}
            >
              Load older tasks
            </Button>
          )}
        </>
      )}
      {selected &&
        !tasks.isError &&
        (detail.isError ? (
          <p role="alert">{errorMessage(detail.error)}</p>
        ) : detail.isPending ? (
          <p role="status">Loading task…</p>
        ) : (
          detail.data && (
            <TaskProgress key={detail.data.id} task={detail.data} reportId={selectedReport} />
          )
        ))}
    </div>
  );
}
