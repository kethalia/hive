// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useProjectConversation", () => ({
  useProjectConversation: vi.fn(() => ({
    view: { phase: "live", turns: [], needsRefresh: false, error: null },
    reconnect: vi.fn(),
  })),
}));
vi.mock("@/components/projects/ProjectTerminal", () => ({
  ProjectTerminal: () => <div>Attached terminal fixture</div>,
}));

import { ProjectWorkspacePanel } from "@/components/projects/ProjectWorkspacePanel";
import { useProjectConversation } from "@/hooks/useProjectConversation";

const workspaceId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "44444444-4444-4444-8444-444444444444";
const repository = {
  provider: "github",
  providerRepositoryId: "123",
  nodeId: "repo",
  fullName: "owner/repo",
  name: "repo",
  owner: "owner",
  defaultBranch: "main",
  private: true,
  archived: false,
  htmlUrl: "https://github.com/owner/repo",
  permissions: { pull: true, push: true, admin: false },
};
const opened = {
  schemaVersion: 1,
  workspaceId,
  projectId,
  providerAccountId: "456",
  repository,
  defaultRevision: "a".repeat(40),
  phase: "awaitingTask",
  currentTaskId: null,
  nativeThreadId: null,
  terminalSessionName: null,
};
const prepared = {
  schemaVersion: 1,
  projectId,
  taskId,
  phase: "running",
  nativeThreadId: "thread",
  terminalSessionName: `project-${"a".repeat(24)}`,
  reason: null,
};
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
beforeEach(() => {
  vi.mocked(useProjectConversation).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/projects?"))
        return response({
          schemaVersion: 1,
          provider: "github",
          providerAccountId: "456",
          repositories: [repository],
          page: 1,
          perPage: 100,
          nextPage: null,
        });
      if (url === "/api/projects/open") return response(opened);
      return response(prepared);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function select() {
  render(<ProjectWorkspacePanel workspaceId={workspaceId} visible enabled tasksEnabled />);
  fireEvent.click(await screen.findByRole("button", { name: "owner/repo" }));
}
describe("project task workspace", () => {
  it("enrolls a selected stable identity and starts no checkout/task before a submitted request", async () => {
    await select();
    await screen.findByLabelText("What do you need?");
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([url]) => String(url))).toHaveLength(2);
    const request = JSON.parse(String(calls[1][1]?.body));
    expect(request).toMatchObject({ workspaceId, repositoryId: "123", providerAccountId: "456" });
    expect(request).not.toHaveProperty("fullName");
  });
  it("reuses a task request ID after an ambiguous failure and opens terminal only on user selection", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    let starts = 0;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/tasks/start") && ++starts === 1)
        throw new TypeError("Network failed");
      return defaultFetch(...args);
    });
    await select();
    fireEvent.change(await screen.findByLabelText("What do you need?"), {
      target: { value: "Fix the bug" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await screen.findByRole("button", { name: "Terminal" });
    const startsCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/tasks/start"));
    expect(JSON.parse(String(startsCalls[0][1]?.body)).requestId).toBe(
      JSON.parse(String(startsCalls[1][1]?.body)).requestId,
    );
    expect(screen.queryByText("Attached terminal fixture")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByText("Attached terminal fixture");
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(screen.getByText("Attached terminal fixture")).toBeInTheDocument();
    expect(startsCalls).toHaveLength(2);
  });
  it("loads the reason for a reopened blocked task without resubmitting its prompt", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]) === "/api/projects/open")
        return response({ ...opened, phase: "blocked", currentTaskId: taskId });
      if (String(args[0]).endsWith("/tasks/status"))
        return response({
          ...prepared,
          phase: "blocked",
          nativeThreadId: null,
          terminalSessionName: null,
          reason: "prompt_submission_uncertain",
        });
      return defaultFetch(...args);
    });
    await select();
    await screen.findByText(/The task may already have started/);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/tasks/start"))).toBe(
      false,
    );
    expect(screen.queryByRole("button", { name: "Start task" })).not.toBeInTheDocument();
  });
  it("retries a recoverable preparation with the same recovery identity after a lost acknowledgement", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    let retries = 0;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (path === "/api/projects/open")
        return response({ ...opened, phase: "blocked", currentTaskId: taskId });
      if (path.endsWith("/tasks/status"))
        return response({
          ...prepared,
          phase: "blocked",
          reason: "native_unavailable",
          nativeThreadId: null,
          terminalSessionName: null,
        });
      if (path.endsWith("/tasks/retry") && ++retries === 1) throw new TypeError("lost reply");
      return defaultFetch(...args);
    });
    await select();
    fireEvent.click(await screen.findByRole("button", { name: "Retry preparation" }));
    await screen.findByText(/Could not confirm recovery/);
    fireEvent.click(screen.getByRole("button", { name: "Retry preparation" }));
    await waitFor(() => expect(retries).toBe(2));
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/tasks/retry"));
    const first = JSON.parse(String(calls[0][1]?.body)),
      second = JSON.parse(String(calls[1][1]?.body));
    expect(first).toEqual(second);
    expect(Object.keys(first).sort()).toEqual(["requestId", "taskId", "workspaceId"]);
    expect(first.taskId).toBe(taskId);
  });
  it("waits for registered persisted history before opening the read connection", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    let observations = 0;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]) === "/api/projects/open")
        return response({ ...opened, phase: "preparing", currentTaskId: taskId });
      if (String(args[0]).endsWith("/tasks/status") && observations++ === 0)
        return response({ ...prepared, phase: "awaitingRegistration", terminalSessionName: null });
      return defaultFetch(...args);
    });
    await select();
    await screen.findByText("Connecting project");
    expect(vi.mocked(useProjectConversation).mock.lastCall?.[1]).toBe(false);
    await waitFor(() => expect(vi.mocked(useProjectConversation).mock.lastCall?.[1]).toBe(true), {
      timeout: 4500,
    });
  });
  it("resumes observing an existing preparation after reopening without submitting a new task", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) =>
      String(args[0]) === "/api/projects/open"
        ? response({ ...opened, phase: "preparing", currentTaskId: taskId })
        : defaultFetch(...args),
    );
    await select();
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/tasks/status")),
      ).toBe(true),
    );
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/tasks/start"))).toBe(
      false,
    );
    expect(screen.queryByLabelText("What do you need?")).not.toBeInTheDocument();
  });
});
