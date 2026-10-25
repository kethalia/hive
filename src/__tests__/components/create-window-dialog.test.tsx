// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "../helpers/discovery";

const mocks = vi.hoisted(() => ({ session: vi.fn(), clone: vi.fn() }));
vi.mock("@/lib/actions/workspaces", () => ({ createSessionAction: mocks.session }));
vi.mock("@/lib/actions/clone-project", () => ({ cloneProjectAction: mocks.clone }));

import { CreateWindowDialog } from "@/components/workspaces/CreateWindowDialog";
import type { CoderWorkspace } from "@/lib/coder/types";

const workspaces = [
  { id: "dev", name: "ai-dev", template_name: "ai-dev-k8s", latest_build: { status: "running" } },
  { id: "helper", name: "helper", latest_build: { status: "running" } },
  { id: "stopped", name: "stopped", latest_build: { status: "stopped" } },
] as CoderWorkspace[];
function setup(kind: "terminal" | "project") {
  const props = { kind, workspaces, onClose: vi.fn(), onOpenPane: vi.fn() };
  return { ...render(<CreateWindowDialog {...props} />), ...props };
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
describe("create window", () => {
  it("asks for a name before creating a session in the chosen running workspace", async () => {
    const { onOpenPane, onClose } = setup("terminal");
    expect(mocks.session).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: "stopped" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Coder workspace"), { target: { value: "helper" } });
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "my-session" } });
    mocks.session.mockResolvedValue({ data: { name: "my-session" } });
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mocks.session).toHaveBeenCalledWith({
      workspaceId: "helper",
      sessionName: "my-session",
    });
    expect(onOpenPane).toHaveBeenCalledWith({
      kind: "terminal",
      workspaceId: "helper",
      sessionName: "my-session",
      label: "my-session",
    });
  });
  it.each([
    "bad/name",
    "bad name",
    "git-clone-reserved",
  ])("rejects invalid session names: %s", async (name) => {
    setup("terminal");
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    await screen.findByRole("alert");
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("clones only after submission, blocks duplicate submits and opens the returned project", async () => {
    const { onOpenPane, onClose } = setup("project");
    let resolve!: (value: unknown) => void;
    mocks.clone.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fireEvent.change(screen.getByLabelText("Organization or owner"), {
      target: { value: "kethalia" },
    });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "hive" } });
    expect(mocks.clone).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Clone and open" });
    fireEvent.submit(button.closest("form")!);
    fireEvent.submit(button.closest("form")!);
    expect(mocks.clone).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Cloning project");
    const pane = { kind: "terminal", workspaceId: "dev", sessionName: "project", label: "hive" };
    await act(async () => resolve({ data: pane }));
    expect(onOpenPane).toHaveBeenCalledWith(pane);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("preserves form values and reports a clone failure", async () => {
    const { onOpenPane } = setup("project");
    mocks.clone.mockResolvedValue({ serverError: "Repository access denied" });
    fireEvent.change(screen.getByLabelText("Organization or owner"), {
      target: { value: "kethalia" },
    });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "private" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone and open" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Repository access denied");
    expect(screen.getByLabelText("Repository")).toHaveValue("private");
    expect(onOpenPane).not.toHaveBeenCalled();
  });
});
