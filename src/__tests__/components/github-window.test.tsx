// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubWindow } from "@/components/projects/GitHubWindow";
import type { CoderWorkspace } from "@/lib/coder/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each([
  false,
  true,
])("waits for a new device approval before reporting success (initial connection %s)", async (initial) => {
  let checks = 0;
  const workspace = {
    id: "one",
    name: "First",
    latest_build: { id: "build-one", status: "running" },
  } as CoderWorkspace;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.workspaceId).toBe("one");
      expect(body.buildId).toBe("build-one");
      const result = {
        revision: "3dc64f73-d2c0-4143-8705-b1bc99ac6bbc",
        outcome: null,
        login: initial ? "octocat" : null,
        pending: null,
      };
      if (body.action === "status") return Response.json(result);
      if (body.action === "poll" && ++checks === 2)
        return Response.json({ ...result, login: "new-account" });
      return Response.json({
        ...result,
        login: null,
        pending: { code: "TEST-CODE", interval: 1, expiresAt: Date.now() + 10000 },
      });
    }),
  );
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <GitHubWindow
        userId="test"
        workspaces={[workspace]}
        workspace={workspace}
        onWorkspaceChange={() => {}}
        onStartWorkspace={async () => {}}
        visible
        navigation={{ id: "github", collapsed: false }}
      />
    </QueryClientProvider>,
  );
  const connect = await screen.findByRole("button", {
    name: initial ? "Reconnect" : "Connect GitHub",
  });
  if (!initial) {
    const panel = screen.getByRole("region", { name: "Workspace GitHub connection" });
    const state = within(panel).getByRole("status");
    expect(panel.firstElementChild).toBe(state);
    expect(state.firstElementChild).toBe(
      within(state).getByRole("heading", { name: "No GitHub account connected" }),
    );
    expect(state.children).toHaveLength(2);
    expect(
      within(panel)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Refresh status", "Connect GitHub"]);
  }
  fireEvent.click(connect);
  expect(await screen.findByText("TEST-CODE")).toBeInTheDocument();
  expect(screen.queryByText("@new-account")).not.toBeInTheDocument();
  expect(await screen.findByText("@new-account", {}, { timeout: 5000 })).toBeVisible();
  const details = screen.getByRole("region", { name: "GitHub connection details" });
  const card = details.querySelector("dl");
  expect(card).toHaveClass("border");
  expect(card).toContainElement(screen.getByText("@new-account"));
  expect(screen.getByRole("heading", { name: "GitHub connection" }).closest(".border")).toBeNull();
  expect(screen.getByText("Connected").closest(".border")).not.toBe(card);
  expect(checks).toBe(2);
});

it("uses the Workspace tab to switch repositories to another workspace or start it", async () => {
  const workspaces = [
    { id: "one", name: "First", latest_build: { id: "build-one", status: "running" } },
    { id: "two", name: "Second", latest_build: { id: "build-two", status: "stopped" } },
  ] as CoderWorkspace[];
  const onStartWorkspace = vi.fn(async () => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.startsWith("/api/projects?")
        ? Response.json({ error: "workspace_unavailable" }, { status: 503 })
        : Response.json({ connected: true, login: "octocat", authorizeUrl: null }),
    ),
  );
  function Window() {
    const [id, setId] = useState("one");
    return (
      <GitHubWindow
        userId="test"
        workspaces={workspaces}
        workspace={workspaces.find((w) => w.id === id)}
        onWorkspaceChange={setId}
        onStartWorkspace={onStartWorkspace}
        visible
        navigation={{ id: "github", collapsed: false }}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Window />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Workspace",
    "Connection",
    "Repositories",
  ]);
  fireEvent.click(screen.getByRole("tab", { name: "Repositories" }));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Review workspace setup" }));
  expect(screen.getByRole("radio", { name: "First, running" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "Second, stopped" }));
  expect(screen.getByRole("tab", { name: "Repositories" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("radio", { name: "Second, stopped" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Start workspace" }));
  expect(onStartWorkspace).toHaveBeenCalledWith("two");
  await screen.findByRole("button", { name: "Start workspace" });
});

it("offers workspace selection when the running helper cannot manage GitHub", async () => {
  const workspace = {
    id: "one",
    name: "First",
    latest_build: { id: "build-one", status: "running" },
  } as CoderWorkspace;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "unsupported_schema" }, { status: 502 })),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GitHubWindow
        userId="test"
        workspaces={[workspace]}
        workspace={workspace}
        onWorkspaceChange={() => {}}
        onStartWorkspace={async () => {}}
        visible
        navigation={{ id: "github", collapsed: false }}
      />
    </QueryClientProvider>,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.parentElement?.firstElementChild).toBe(alert);
  expect(alert.firstElementChild).toBe(
    within(alert).getByRole("heading", { name: "Could not verify GitHub connection" }),
  );
  expect(alert).toHaveTextContent("Update the workspace template for First");
  expect(screen.queryByText("Checking GitHub connection…")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Choose workspace" }));
  expect(screen.getByRole("radio", { name: "First, running" })).toBeChecked();
});

it.each([
  { action: "status", login: "octocat", display: "@octocat" },
  { action: "poll", login: null, display: "TEST-CODE" },
  { action: "start", login: "octocat", display: "@octocat" },
] as const)("clears the GitHub connection cache when $action is denied", async ({
  action,
  login,
  display,
}) => {
  const workspace = {
    id: "one",
    name: "First",
    latest_build: { id: "build-one", status: "running" },
  } as CoderWorkspace;
  const revision = "3dc64f73-d2c0-4143-8705-b1bc99ac6bbc";
  const queryKey = ["github-connection", "test", workspace.id, workspace.latest_build.id];
  const fetchConnection = vi.fn<typeof fetch>();
  fetchConnection.mockResolvedValueOnce(
    Response.json({
      revision,
      login,
      pending:
        action === "poll"
          ? { code: "TEST-CODE", interval: 120, expiresAt: Date.now() + 120_000 }
          : null,
      outcome: null,
    }),
  );
  vi.stubGlobal("fetch", fetchConnection);
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <GitHubWindow
        userId="test"
        workspaces={[workspace]}
        workspace={workspace}
        onWorkspaceChange={() => {}}
        onStartWorkspace={() => {}}
        visible
        navigation={{ id: "github", collapsed: false }}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(display)).toBeVisible();

  const requestBody = (call = fetchConnection.mock.lastCall) => JSON.parse(String(call?.[1]?.body));
  const temporaryFailure = () => Response.json({ error: "workspace_unavailable" }, { status: 502 });
  fetchConnection.mockImplementation(async () => temporaryFailure());
  if (action !== "start") {
    fetchConnection.mockResolvedValueOnce(temporaryFailure());
    await act(() => client.refetchQueries({ queryKey }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Start and connect your workspace");
    expect(screen.getByText(display)).toBeVisible();
  }

  const deniedRequest = fetchConnection.mock.calls.length;
  fetchConnection.mockResolvedValueOnce(new Response(null, { status: 401 }));
  if (action === "start") fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  else await act(() => client.refetchQueries({ queryKey }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Sign in to Hive"));
  expect(requestBody(fetchConnection.mock.calls[deniedRequest])).toMatchObject(
    action === "status" ? { action } : { action, revision },
  );
  expect(screen.queryByText(display)).toBeNull();
  expect(client.getQueryData(queryKey)).toBeNull();

  if (action !== "start") fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() =>
    expect(client.getQueryState(queryKey)?.error?.message).toContain(
      "Start and connect your workspace",
    ),
  );
  expect(requestBody()).toEqual({ workspaceId: "one", buildId: "build-one", action: "status" });
  expect(screen.queryByText(display)).toBeNull();
  expect(client.getQueryData(queryKey)).toBeNull();

  fetchConnection.mockResolvedValueOnce(
    Response.json({ revision, login: "reauthorized", pending: null, outcome: null }),
  );
  if (action === "start") await act(() => client.refetchQueries({ queryKey }));
  else fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(await screen.findByText("@reauthorized")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});
