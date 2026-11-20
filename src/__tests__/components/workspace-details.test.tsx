// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceDetails } from "@/components/workspaces/WorkspaceDetails";
import type { CoderWorkspace } from "@/lib/coder/types";

const workspace: CoderWorkspace = {
  id: "workspace-1",
  name: "ai-dev",
  owner_name: "owner",
  template_id: "template-1",
  latest_build: { id: "build-1", status: "running", job: { status: "succeeded", error: "" } },
};
const lines = [
  { id: 1, stage: "Preparing", output: "Provisioner ready", created_at: "2026-11-20T01:00:00Z" },
  { id: 2, stage: "Starting", output: "Agent starting", created_at: "2026-11-20T01:00:01Z" },
];
const nextLine = { ...lines[1], id: 3, output: "Agent ready" };
const queryKey = ["workspace-build-logs", "user", workspace.id];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openWorkspaceDetails() {
  const fetchLogs = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ workspace, logs: lines }));
  vi.stubGlobal("fetch", fetchLogs);
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <WorkspaceDetails
        workspace={workspace}
        userId="user"
        visible
        onStart={vi.fn()}
        onStop={vi.fn()}
        renderWindow={(_status, content) => content}
      />
    </QueryClientProvider>,
  );
  return { fetchLogs, poll: () => act(() => client.refetchQueries({ queryKey })) };
}

it("keeps the selected build log stage and scroll position across a failed poll and retry", async () => {
  const { fetchLogs, poll } = openWorkspaceDetails();
  fireEvent.click(await screen.findByRole("tab", { name: "Starting" }));
  const logList = screen.getByRole("list", { name: "Latest build output" });
  Object.defineProperties(logList, { scrollHeight: { value: 400 }, clientHeight: { value: 120 } });
  logList.scrollTop = 24;
  fireEvent.scroll(logList);

  fetchLogs.mockResolvedValueOnce(Response.json({}, { status: 502 }));
  await poll();
  expect(await screen.findByRole("alert")).toHaveTextContent("Showing the last confirmed output");
  expect(screen.getByRole("tab", { name: "Starting" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("list", { name: "Latest build output" })).toBe(logList);
  expect(logList.scrollTop).toBe(24);

  fetchLogs.mockResolvedValueOnce(Response.json({ workspace, logs: [nextLine] }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(nextLine.output);
  expect(screen.getByRole("tab", { name: "Starting" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("list", { name: "Latest build output" })).toBe(logList);
  expect(logList.scrollTop).toBe(24);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("requires a fresh log snapshot after access is denied", async () => {
  const { fetchLogs, poll } = openWorkspaceDetails();
  await screen.findByText(lines[1].output);
  fetchLogs.mockResolvedValueOnce(Response.json({}, { status: 403 }));
  await poll();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load build logs");
  expect(screen.queryByText(lines[1].output)).toBeNull();

  fetchLogs.mockResolvedValueOnce(Response.json({}, { status: 502 }));
  await poll();
  await waitFor(() => expect(fetchLogs).toHaveBeenCalledTimes(3));
  expect(screen.queryByText(lines[1].output)).toBeNull();

  fetchLogs.mockResolvedValueOnce(Response.json({ workspace, logs: [nextLine] }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(nextLine.output);
  expect(fetchLogs.mock.lastCall?.[0]).not.toContain("after=");
  expect(screen.queryByText(lines[1].output)).toBeNull();
});
