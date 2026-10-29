// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryPanel } from "@/components/delivery/DeliveryPanel";

const taskId = "22222222-2222-4222-8222-222222222222";
const reportId = "33333333-3333-4333-8333-333333333333";
const stepId = "44444444-4444-4444-8444-444444444444";
const now = "2026-10-29T12:00:00.000Z";
const summary = {
  id: taskId,
  outcome: "Fix reconnect behavior",
  projectName: "kethalia/hive",
  branch: "codex/test",
  sourceSha: "a".repeat(40),
  createdAt: now,
  version: 0,
  pauseRequested: false,
  schedulingPaused: false,
  releaseMode: "disabled",
  counts: { total: 1, succeeded: 1, attention: 0 },
};
const detail = {
  ...summary,
  recentEvents: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      label: "Step blocked",
      reason: "Waiting for approval <script>unsafe()</script>",
      stepId,
      reportId: null,
      createdAt: now,
    },
  ],
  steps: [
    {
      id: stepId,
      kind: "validate",
      state: "succeeded",
      acceptancePhase: "implementation_preview",
      attemptCount: 1,
      attemptBudget: 3,
      dependencies: [],
      latestAttempt: null,
      reports: [
        {
          id: reportId,
          summary: "Reconnect test passed",
          difficulty: "moderate",
          difficultyReason: "Recovered from a dropped stream",
          issues: [{ summary: "Stale snapshot", resolution: "Added revision check" }],
          remainingUncertainty: "Browser test still pending",
          nextAction: "Run browser pilot",
          createdAt: now,
          evidence: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              kind: "check",
              status: "passed",
              verificationMode: "simulated",
              environment: "local fixture",
              sourceSha: "a".repeat(40),
              observedAt: now,
              invalidatedAt: null,
            },
          ],
        },
      ],
    },
  ],
};
const clients: QueryClient[] = [];
function mount(props: Partial<React.ComponentProps<typeof DeliveryPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <DeliveryPanel userId="owner-a" enabled {...props} />
    </QueryClientProvider>,
  );
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url.split("?")[0].endsWith(taskId) ? detail : { tasks: [summary], nextCursor: null },
          ),
        ),
      ),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});
describe("Delivery window", () => {
  it("requests scheduling pause once and displays the server's still-running state", async () => {
    let paused = false;
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (init?.method === "POST")
        return new Promise((r) => {
          resolve = r;
        });
      return Promise.resolve(
        response(
          String(url).split("?")[0].endsWith(taskId)
            ? {
                ...detail,
                pauseRequested: paused,
                schedulingPaused: false,
                version: paused ? 1 : 0,
              }
            : { tasks: [summary], nextCursor: null },
        ),
      );
    });
    mount({ taskId });
    const button = await screen.findByRole("button", { name: "Pause scheduling" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Updating scheduling…" })).toBeDisabled();
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({
      expectedVersion: 0,
      paused: true,
    });
    paused = true;
    resolve(response({ version: 1, replayed: false }));
    expect(
      await screen.findByText("Pause requested; waiting for active work to stop safely."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Resume scheduling" })).toBeEnabled();
    expect(screen.queryByText("Scheduling paused.")).not.toBeInTheDocument();
  });
  it("retries a lost acknowledgement with the exact original request after state advances", async () => {
    let calls = 0;
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (init?.method === "POST") {
        calls++;
        return calls === 1
          ? Promise.reject(new Error("lost response"))
          : Promise.resolve(response({ version: 1, replayed: true }));
      }
      return Promise.resolve(
        response(
          String(url).split("?")[0].endsWith(taskId)
            ? {
                ...detail,
                pauseRequested: calls > 0,
                schedulingPaused: calls > 0,
                version: calls > 0 ? 1 : 0,
              }
            : { tasks: [summary], nextCursor: null },
        ),
      );
    });
    mount({ taskId });
    fireEvent.click(await screen.findByRole("button", { name: "Pause scheduling" }));
    const retry = await screen.findByRole("button", { name: "Retry scheduling request" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Resume scheduling" });
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
    expect(JSON.parse(String(posts[1][1]?.body)).paused).toBe(true);
  });
  it("refreshes a conflicting request without automatically overwriting the new state", async () => {
    let changed = false;
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (init?.method === "POST") {
        changed = true;
        return Promise.resolve(response({ error: "task_changed" }, 409));
      }
      return Promise.resolve(
        response(
          String(url).split("?")[0].endsWith(taskId)
            ? {
                ...detail,
                pauseRequested: changed,
                schedulingPaused: changed,
                version: changed ? 2 : 0,
              }
            : { tasks: [summary], nextCursor: null },
        ),
      );
    });
    mount({ taskId });
    fireEvent.click(await screen.findByRole("button", { name: "Pause scheduling" }));
    expect(
      await screen.findByText("The task changed. Review its current state before trying again."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Scheduling paused.")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      1,
    );
  });
  it("separates informational analysis from evidence acceptance and shows unverified difficulty/issues", async () => {
    const counts = { ...summary.counts, succeeded: 0, reported: 1 };
    const analysis = {
      ...detail,
      counts,
      steps: [
        {
          ...detail.steps[0],
          kind: "understand",
          state: "reported",
          reports: [
            {
              ...detail.steps[0].reports[0],
              informational: true,
              sourceSha: "a".repeat(40),
              summary: "Understanding report recorded",
              evidence: [],
            },
          ],
        },
      ],
    };
    vi.mocked(fetch).mockImplementation((url) =>
      Promise.resolve(
        response(
          String(url).split("?")[0].endsWith(taskId)
            ? analysis
            : { tasks: [{ ...summary, counts }], nextCursor: null },
        ),
      ),
    );
    mount({ taskId, reportId });
    expect(await screen.findByText("Understanding report recorded")).toBeInTheDocument();
    expect(
      screen.getByText("Informational report · not independently verified"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/0 accepted with evidence · 1 informational · 1 step/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Difficulty: moderate/)).toBeInTheDocument();
    expect(screen.getByText("Stale snapshot")).toBeInTheDocument();
    expect(screen.queryByText(/check · passed/)).not.toBeInTheDocument();
  });
  it("shows notices and renders their reasons as text", async () => {
    mount({ taskId });
    const activity = await screen.findByRole("region", { name: "Recent task activity" });
    expect(activity).toHaveTextContent("Step blocked");
    expect(activity).toHaveTextContent("Waiting for approval <script>unsafe()</script>");
    expect(activity.querySelector("script")).toBeNull();
  });
  it("does not fetch when disabled or hidden", () => {
    const view = mount({ enabled: false });
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();
    mount({ visible: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("selects a task and exposes honest report details without claiming production", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Fix reconnect behavior/ }));
    expect(await screen.findByText("Reconnect test passed")).toBeInTheDocument();
    expect(screen.getByText("Implementation and preview · Attempt 1 of 3")).toBeInTheDocument();
    expect(screen.getByText(/Difficulty: moderate/)).toBeInTheDocument();
    expect(screen.getByText("Stale snapshot")).toBeInTheDocument();
    expect(screen.getByText(/simulated · local fixture/)).toBeInTheDocument();
    expect(screen.getByText(/Automatic production delivery is not enabled/)).toBeInTheDocument();
  });
  it("opens the linked report directly", async () => {
    mount({ taskId, reportId });
    const report = await screen.findByText("Reconnect test passed");
    expect(report.closest("details")).toHaveAttribute("open");
  });
  it("hides cached content after authentication expires", async () => {
    mount({ taskId });
    await screen.findByText("Reconnect test passed");
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(response({ error: "not_authenticated" }, 401)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in again");
    expect(screen.queryByText("Reconnect test passed")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Fix reconnect behavior/ }),
    ).not.toBeInTheDocument();
  });
  it("discards a late detail response after switching tasks", async () => {
    const secondId = "66666666-6666-4666-8666-666666666666";
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation((url) => {
      if (String(url).endsWith(taskId))
        return new Promise((r) => {
          resolve = r;
        });
      if (String(url).endsWith(secondId))
        return Promise.resolve(
          response({ ...detail, id: secondId, outcome: "Second task", steps: [] }),
        );
      return Promise.resolve(
        response({
          tasks: [summary, { ...summary, id: secondId, outcome: "Second task" }],
          nextCursor: null,
        }),
      );
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Fix reconnect behavior/ }));
    await waitFor(() => expect(resolve).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Second task/ }));
    await screen.findByRole("heading", { name: "Second task" });
    resolve(response(detail));
    await waitFor(() =>
      expect(screen.queryByText("Reconnect test passed")).not.toBeInTheDocument(),
    );
  });
});
