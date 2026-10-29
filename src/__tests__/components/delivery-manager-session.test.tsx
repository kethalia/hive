// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/hooks/useProjectConversation", () => ({
  useProjectConversation: vi.fn(() => ({
    view: { phase: "live", turns: [], needsRefresh: false, error: null },
    reconnect: vi.fn(),
  })),
}));
vi.mock("@/components/projects/ProjectTerminal", () => ({
  ProjectTerminal: vi.fn(() => <div>Manager terminal fixture</div>),
}));

import { DeliveryManagerSession } from "@/components/delivery/DeliveryManagerSession";
import { ProjectTerminal } from "@/components/projects/ProjectTerminal";
import { useProjectConversation } from "@/hooks/useProjectConversation";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("opens the exact manager read stream and mounts its terminal only on request", async () => {
  const manager = {
    projectId: "project",
    conversationId: "conversation",
    workspaceId: "workspace",
    threadId: "thread",
  };
  render(<DeliveryManagerSession manager={manager} />);
  expect(useProjectConversation).toHaveBeenCalledWith("project", true, manager);
  expect(screen.queryByText("Manager terminal fixture")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  await screen.findByText("Manager terminal fixture");
  expect(vi.mocked(ProjectTerminal).mock.calls.at(-1)?.[0]).toMatchObject({
    projectId: "project",
    expected: manager,
    visible: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
  expect(screen.getByText("Manager terminal fixture")).toBeInTheDocument();
  expect(vi.mocked(ProjectTerminal).mock.calls.at(-1)?.[0].visible).toBe(false);
});
