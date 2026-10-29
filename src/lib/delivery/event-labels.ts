const labels: Record<string, string> = {
  task_created: "Task created",
  attempt_started: "Step started",
  step_completed: "Step completed",
  attempt_failed: "Step failed",
  attempt_blocked: "Step blocked",
  step_blocked: "Step blocked",
  step_retry_requested: "Retry requested",
  step_invalidated: "Step evidence invalidated",
  step_reopened: "Step reopened",
  source_changed: "Source revision changed; scheduling paused",
  pause_requested: "Pause requested",
  scheduling_resumed: "Scheduling resumed",
  safety_pause_requested: "Scheduling paused for review",
  native_runtime_bound: "Agent execution registered",
  native_attempt_quiescent: "Agent execution stopped",
  native_attempt_observed: "Agent execution requires attention",
  expired_attempt_reconciled: "Interrupted attempt reconciled",
};
export function deliveryEventLabel(type: string) {
  return labels[type] ?? "Delivery task updated";
}
