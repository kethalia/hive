// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/dynamic", async () => ({
  default: (await import("next/dist/shared/lib/app-dynamic")).default,
}));
vi.mock("@/components/workspaces/TerminalSessionFrame", () => ({
  TerminalSessionFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { HiveWorkspacePane } from "@/components/workspaces/HiveWorkspacePane";
import type { CoderWorkspace } from "@/lib/coder/types";

const lifetimeId = "00000000-0000-4000-8000-000000000001";
const workspaces = [
  { id: "one", name: "Software one", latest_build: { id: "build-one", status: "running" } },
  { id: "two", name: "Software two", latest_build: { id: "build-two", status: "running" } },
] as CoderWorkspace[];
const select = vi.fn();
const fetcher = vi.fn();
function accountResponse(path: string) {
  return Response.json({
    scope: path.endsWith("/claude-account") ? "workspace-cli" : "managed-native",
    lifetimeId,
    generation: 0,
    state: "signed-out",
    pending: null,
  });
}
function tree(
  workspaceId = "one",
  buildId: string | undefined = "build-one",
  options: {
    workspaces?: CoderWorkspace[];
    visible?: boolean;
    userId?: string;
    tool?: "codex-account" | "claude-account";
  } = {},
) {
  return (
    <HiveWorkspacePane
      pane={{
        id: options.tool ?? "codex-account",
        kind: "hive",
        tool: options.tool ?? "codex-account",
        label: options.tool === "claude-account" ? "Claude" : "Codex",
        workspaceId,
        buildId,
      }}
      userId={options.userId ?? "owner"}
      workspaces={options.workspaces ?? workspaces}
      active
      visible={options.visible ?? true}
      launchRequest={0}
      onActivate={() => {}}
      onClose={() => {}}
      onWorkspaceChange={select}
      onOpenSession={() => {}}
    />
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  fetcher.mockImplementation(async (path: string) => accountResponse(path));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["codex-account", "Managed Codex account", "Workspace Claude account"],
  ["claude-account", "Workspace Claude account", "Managed Codex account"],
] as const)("loads only the %s provider for the selected visible workspace", async (tool, own, other) => {
  const view = render(tree("one", "build-one", { tool, visible: false }));
  expect(fetcher).not.toHaveBeenCalled();
  view.rerender(tree("one", "build-one", { tool }));
  expect(await screen.findByRole("region", { name: own })).toBeVisible();
  expect(screen.queryByRole("region", { name: other })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([`/api/workspaces/one/${tool}`]);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    buildId: "build-one",
    request: { action: "status" },
  });
  view.rerender(tree("one", "build-one", { tool, visible: false }));
  expect(screen.queryByRole("region", { name: own })).not.toBeInTheDocument();
});

it("explains disabled Claude connections in the Claude window", async () => {
  fetcher.mockResolvedValue(new Response(null, { status: 404 }));
  render(tree("one", "build-one", { tool: "claude-account" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(screen.getByRole("combobox", { name: "Account workspace" })).toBeVisible();
  expect(await screen.findByText(/Claude connection is unavailable/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect Claude" })).not.toBeInTheDocument();
});

it.each([
  "missing",
  "stopped",
  "old-build",
])("does not substitute another running workspace or build for a %s selection", async (scope) => {
  render(
    tree(
      scope === "missing" ? "missing" : "one",
      scope === "old-build" ? "old-build" : "build-one",
      {
        workspaces:
          scope === "stopped"
            ? workspaces.map((w) =>
                w.id === "one"
                  ? { ...w, latest_build: { ...w.latest_build, status: "stopped" } }
                  : w,
              )
            : workspaces,
      },
    ),
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Managed Codex account" })).not.toBeInTheDocument();
  if (scope === "old-build") {
    fireEvent.click(screen.getByRole("button", { name: "Use current build" }));
    expect(select).toHaveBeenCalledExactlyOnceWith("one", "build-one");
    expect(fetcher).not.toHaveBeenCalled();
  }
});

it("uses the existing workspace selector and returns the selected current build without confirmation", async () => {
  render(tree());
  await screen.findByRole("region", { name: "Managed Codex account" });
  fireEvent.click(screen.getByRole("combobox", { name: "Account workspace" }));
  const option = await screen.findByRole("option", { name: "Software two · running" });
  fireEvent.mouseMove(option);
  fireEvent.click(option);
  expect(select).toHaveBeenCalledExactlyOnceWith("two", "build-two");
});

it("drops late old-workspace and old-build status replies before mounting fresh account lifetimes", async () => {
  let oldReply!: (response: Response) => void;
  fetcher.mockImplementation((path: string) =>
    path === "/api/workspaces/one/codex-account"
      ? new Promise<Response>((resolve) => {
          oldReply = resolve;
        })
      : Promise.resolve(accountResponse(path)),
  );
  const view = render(tree());
  await waitFor(() => expect(oldReply).toBeDefined());
  view.rerender(tree("two", "build-two"));
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Managed Codex account" })).toHaveTextContent(
      "No Codex account connected",
    ),
  );
  await act(async () =>
    oldReply(
      Response.json({
        scope: "managed-native",
        lifetimeId,
        generation: 1,
        state: "pending",
        pending: {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "OLD-CODE",
          expiresAt: Date.now() + 600000,
        },
      }),
    ),
  );
  expect(screen.queryByText("OLD-CODE")).not.toBeInTheDocument();
  fetcher.mockImplementation(async (path: string) => accountResponse(path));
  const before = fetcher.mock.calls.length;
  view.rerender(
    tree("two", "new-build", {
      workspaces: workspaces.map((w) =>
        w.id === "two" ? { ...w, latest_build: { ...w.latest_build, id: "new-build" } } : w,
      ),
    }),
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(before + 1));
  expect(screen.queryByText("OLD-CODE")).not.toBeInTheDocument();
});

it("holds a rebuilt workspace until its current build is explicitly selected", async () => {
  const view = render(tree());
  await screen.findByRole("button", { name: "Connect Codex" });
  const originalRequests = fetcher.mock.calls.length;
  const currentWorkspaces = workspaces.map((workspace) =>
    workspace.id === "one"
      ? { ...workspace, latest_build: { ...workspace.latest_build, id: "replacement-build" } }
      : workspace,
  );
  view.rerender(tree("one", "build-one", { workspaces: currentWorkspaces }));
  expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(originalRequests);
  fireEvent.click(screen.getByRole("button", { name: "Use current build" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("one", "replacement-build");
  expect(fetcher).toHaveBeenCalledTimes(originalRequests);
  view.rerender(tree("one", "replacement-build", { workspaces: currentWorkspaces }));
  await screen.findByRole("button", { name: "Connect Codex" });
  for (const [, request] of fetcher.mock.calls.slice(originalRequests))
    expect(JSON.parse(request.body)).toEqual({
      buildId: "replacement-build",
      request: { action: "status" },
    });
});
