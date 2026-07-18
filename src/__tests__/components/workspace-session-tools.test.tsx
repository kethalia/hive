// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockGetWorkspaceSessionTools = vi.fn();
const mockOpenWorkspaceToolPopup = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  getWorkspaceSessionToolsAction: (...args: unknown[]) => mockGetWorkspaceSessionTools(...args),
}));

vi.mock("@/lib/workspaces/embedded-tools", () => ({
  openWorkspaceToolPopup: (...args: unknown[]) => mockOpenWorkspaceToolPopup(...args),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid={String(props["data-testid"])}>{children}</div>
  ),
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

vi.mock("lucide-react", () => ({
  Code2: () => <span>Code icon</span>,
  ExternalLink: () => <span>External icon</span>,
  FolderOpen: () => <span>Folder icon</span>,
  Loader2: () => <span>Loading</span>,
}));

import { WorkspaceSessionTools } from "@/components/workspaces/WorkspaceSessionTools";

describe("WorkspaceSessionTools", () => {
  beforeEach(() => {
    mockGetWorkspaceSessionTools.mockResolvedValue({
      data: {
        codeUrl: "https://code.test/?folder=%2Fhome%2Fcoder%2Fhive",
        filesUrl: "https://files.test/files/home/coder/hive",
        folderPath: "/home/coder/hive",
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("embeds File Browser and switches to VS Code without leaving the workspace", async () => {
    render(
      <WorkspaceSessionTools
        workspaceId="ws-1"
        sessionName="git-hive"
        label="Hive"
        fallbackPath="/home/coder/hive"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse files for Hive" }));
    await waitFor(() => expect(screen.getByTestId("workspace-tool-frame")).toBeInTheDocument());
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      fallbackPath: "/home/coder/hive",
    });
    expect(screen.getByTestId("workspace-tool-frame")).toHaveAttribute(
      "src",
      "https://files.test/files/home/coder/hive",
    );

    fireEvent.click(screen.getByRole("tab", { name: /VS Code/ }));
    expect(screen.getByTestId("workspace-tool-frame")).toHaveAttribute(
      "src",
      "https://code.test/?folder=%2Fhome%2Fcoder%2Fhive",
    );
    expect(screen.getByRole("tab", { name: /VS Code/ })).toHaveAttribute("aria-selected", "true");
  });

  it("pops the active tool out with the same resolved URL", async () => {
    render(<WorkspaceSessionTools workspaceId="ws-1" sessionName="shell" label="Shell" />);
    fireEvent.click(screen.getByRole("button", { name: "Open VS Code for Shell" }));
    await waitFor(() => expect(screen.getByTestId("workspace-tool-frame")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open VS Code in a new window" }));
    expect(mockOpenWorkspaceToolPopup).toHaveBeenCalledWith(
      "https://code.test/?folder=%2Fhome%2Fcoder%2Fhive",
      "code",
    );
  });
});
