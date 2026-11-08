// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeConfigProvider } from "@/components/runtime-config-provider";
import type { CoderWorkspace } from "@/lib/coder/types";

const observed = vi.hoisted(() => ({ panel: vi.fn() }));
vi.mock("next/dynamic", () => ({
  default: () => (props: unknown) => {
    observed.panel(props);
    return <p>GitHub browser mounted</p>;
  },
}));
vi.mock("@/components/workspaces/TerminalSessionFrame", () => ({
  TerminalSessionFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { HiveWorkspacePane } from "@/components/workspaces/HiveWorkspacePane";

const template = "00000000-0000-4000-8000-000000000001";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function mount(supported: boolean) {
  const workspace = {
    id: "workspace",
    name: "current",
    template_id: supported ? template : "00000000-0000-4000-8000-000000000002",
    latest_build: { id: "build", status: "running" },
  } as CoderWorkspace;
  render(
    <RuntimeConfigProvider
      config={{
        terminalWsUrl: "/",
        projectDiscoveryEnabled: true,
        projectTasksEnabled: true,
        workspaceCapabilities: {
          projectTemplateIds: [template],
          readTemplateIds: [],
          terminalEnabled: false,
        },
      }}
    >
      <HiveWorkspacePane
        pane={{
          id: "projects",
          kind: "hive",
          tool: "projects",
          label: "Projects",
          workspaceId: workspace.id,
        }}
        userId="owner"
        workspaces={[workspace]}
        active
        visible
        launchRequest={0}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onWorkspaceChange={vi.fn()}
        onOpenSession={vi.fn()}
      />
    </RuntimeConfigProvider>,
  );
}
it("explains an unsupported workspace and opens its setup without querying repositories", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const open = vi.fn();
  window.addEventListener("hive:window-open", open);
  try {
    mount(false);
    expect(screen.getByRole("status")).toHaveTextContent("not configured for GitHub projects");
    fireEvent.click(screen.getByRole("button", { name: "Review workspace templates" }));
    expect(open.mock.calls[0][0].detail).toEqual({ tool: "templates", workspaceId: "workspace" });
    expect(observed.panel).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("hive:window-open", open);
  }
});
it("mounts the existing F03 project browser directly on an enrolled workspace", () => {
  mount(true);
  expect(screen.getByText("GitHub browser mounted")).toBeInTheDocument();
  expect(observed.panel).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      enabled: true,
      tasksEnabled: true,
      visible: true,
    }),
  );
});
