// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "../helpers/discovery";

vi.mock("@/lib/actions/agent-tools", () => ({
  inspectAgentToolsAction: vi.fn(),
  configureAgentToolsAction: vi.fn(),
  resumeAgentSessionAction: vi.fn(),
}));

import { AgentToolsPanel } from "@/components/workspaces/AgentToolsPanel";
import {
  configureAgentToolsAction,
  inspectAgentToolsAction,
  resumeAgentSessionAction,
} from "@/lib/actions/agent-tools";
import type { AgentToolsSnapshot } from "@/lib/agents/types";

const id = "11111111-1111-4111-8111-111111111111";
const snapshot: AgentToolsSnapshot = {
  profile: "software",
  checkedAt: 1790000000,
  coderMcpSupported: true,
  typescriptServerInstalled: false,
  agents: ["codex", "claude"].map((agent) => ({
    agent: agent as "codex" | "claude",
    installed: true,
    version: "1.2.3",
    auth: "signed-in",
    tracking: false,
    connections: [],
    plugins: [],
    warnings: [],
  })),
  sessions: [
    {
      key: `codex-${id}`,
      id,
      agent: "codex",
      project: "hive",
      directory: "projects/kethalia/hive",
      updatedAt: 1790000000,
      state: "offline",
      running: false,
      directoryExists: true,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
  vi.mocked(inspectAgentToolsAction).mockResolvedValue({ data: structuredClone(snapshot) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("agent tools panel", () => {
  it("does not scan or mutate when closed", () => {
    render(<AgentToolsPanel workspaceId={id} open={false} onOpenSession={vi.fn()} />);
    expect(inspectAgentToolsAction).not.toHaveBeenCalled();
    expect(configureAgentToolsAction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "unavailable",
    "loading",
  ])("opens scoped Accounts without mounting account readers when generic inventory is %s", async (state) => {
    if (state === "unavailable")
      vi.mocked(inspectAgentToolsAction).mockResolvedValue({
        serverError: "Generic agent tools are disabled",
      });
    else vi.mocked(inspectAgentToolsAction).mockReturnValue(new Promise(() => {}));
    const listener = vi.fn();
    window.addEventListener("hive:window-open", listener);
    try {
      render(
        <AgentToolsPanel workspaceId={id} buildId="current-build" open onOpenSession={vi.fn()} />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Open Accounts" }));
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].detail).toEqual({
        tool: "accounts",
        workspaceId: id,
        buildId: "current-build",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("region", { name: "Managed Codex account" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "Workspace Claude account" }),
      ).not.toBeInTheDocument();
      expect(configureAgentToolsAction).not.toHaveBeenCalled();
      expect(resumeAgentSessionAction).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("hive:window-open", listener);
    }
  });

  it("searches session metadata and resumes the selected ID only", async () => {
    const open = vi.fn();
    vi.mocked(resumeAgentSessionAction).mockResolvedValue({ data: { sessionName: "recovered" } });
    render(<AgentToolsPanel workspaceId={id} open onOpenSession={open} />);
    await screen.findByText("hive · Codex");
    fireEvent.change(screen.getByLabelText("Search agent sessions"), {
      target: { value: "missing" },
    });
    expect(screen.getByText("No conversations match your search.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search agent sessions"), {
      target: { value: "kethalia" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("recovered"));
    expect(resumeAgentSessionAction).toHaveBeenCalledWith({ workspaceId: id, key: `codex-${id}` });
    expect(configureAgentToolsAction).not.toHaveBeenCalled();
  });

  it("keeps the panel open when recovery fails", async () => {
    const open = vi.fn();
    vi.mocked(resumeAgentSessionAction).mockResolvedValue({ serverError: "Folder unavailable" });
    render(<AgentToolsPanel workspaceId={id} open onOpenSession={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder unavailable");
    expect(open).not.toHaveBeenCalled();
  });

  it("ignores a recovery response after the panel unmounts", async () => {
    const open = vi.fn();
    let resolve!: (value: { data: { sessionName: string } }) => void;
    vi.mocked(resumeAgentSessionAction).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(
      <StrictMode>
        <AgentToolsPanel workspaceId={id} open onOpenSession={open} />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    view.unmount();
    await act(async () => resolve({ data: { sessionName: "recovered" } }));
    expect(open).not.toHaveBeenCalled();
  });

  it("installs tracking only after an explicit click", async () => {
    vi.mocked(configureAgentToolsAction).mockResolvedValue({
      data: { message: "Review Codex /hooks" },
    });
    render(<AgentToolsPanel workspaceId={id} open onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable tracking" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Review Codex /hooks");
    expect(configureAgentToolsAction).toHaveBeenCalledWith({
      workspaceId: id,
      operation: "install",
    });
  });

  it("does not offer Coder setup in a specialist workspace", async () => {
    vi.mocked(inspectAgentToolsAction).mockResolvedValue({
      data: { ...snapshot, profile: "browser", coderMcpSupported: false },
    });
    render(<AgentToolsPanel workspaceId={id} open onOpenSession={vi.fn()} />);
    await screen.findByText("Available in the software workspace.");
    expect(screen.queryByRole("button", { name: "Connect Coder" })).not.toBeInTheDocument();
  });
});

vi.mock(
  "@/lib/discovery/transport",
  async () => (await import("../helpers/discovery-transport")).discoveryTransport,
);
