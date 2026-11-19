// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubWindow } from "@/components/projects/GitHubWindow";

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
