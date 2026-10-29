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
