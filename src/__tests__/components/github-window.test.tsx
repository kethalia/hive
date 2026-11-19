// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  let connected = initial,
    checks = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const action = options.body && JSON.parse(options.body).action;
      if (!action)
        return Response.json({
          connected,
          login: connected ? "octocat" : null,
          authorizeUrl: null,
        });
      if (action === "start")
        return Response.json({
          attempt: "test-attempt",
          userCode: "TEST-CODE",
          verificationUrl: "https://github.com/login/device",
          interval: 0.1,
          expiresAt: Date.now() + 10000,
        });
      checks++;
      if (checks === 1) return Response.json({ state: "pending" });
      connected = true;
      return Response.json({ state: "approved" });
    }),
  );
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <GitHubWindow
        userId="test"
        workspaces={[]}
        onWorkspaceChange={() => {}}
        onStartWorkspace={async () => {}}
        visible
        navigation={{ id: "github", collapsed: false }}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: initial ? "Reconnect GitHub" : "Connect GitHub" }),
  );
  expect(await screen.findByText("TEST-CODE")).toBeInTheDocument();
  expect(screen.queryByText("GitHub sign-in complete.")).not.toBeInTheDocument();
  expect(await screen.findByText("GitHub sign-in complete.")).toBeInTheDocument();
  expect(await screen.findByText("Connected as @octocat")).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("tab", { name: "Repositories" }));
  expect(screen.getByRole("status")).toHaveTextContent("Choose a running Coder workspace");
  fireEvent.click(screen.getByRole("button", { name: "Review workspace setup" }));
  expect(screen.getByRole("radio", { name: "Second, stopped" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Start workspace" }));
  expect(onStartWorkspace).toHaveBeenCalledWith("two");
  await screen.findByRole("button", { name: "Start workspace" });
});
