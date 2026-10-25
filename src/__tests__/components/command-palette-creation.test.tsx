// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "../helpers/discovery";

const mocks = vi.hoisted(() => ({ session: vi.fn(), clone: vi.fn() }));
vi.mock("@/lib/actions/workspaces", () => ({ createSessionAction: mocks.session }));
vi.mock("@/lib/actions/clone-project", () => ({ cloneProjectAction: mocks.clone }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { CommandPalette } from "@/components/terminal/CommandPalette";
import { useWindowCreationPages } from "@/hooks/useWindowCreationPages";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";

const workspaces = [
  { id: "dev", name: "ai-dev", template_name: "ai-dev-k8s", latest_build: { status: "running" } },
  { id: "helper", name: "helper", latest_build: { status: "running" } },
  { id: "stopped", name: "stopped", latest_build: { status: "stopped" } },
] as CoderWorkspace[];
function Harness({
  onOpenPane,
  available = workspaces,
}: {
  onOpenPane: (pane: GeneralPane) => void;
  available?: CoderWorkspace[];
}) {
  const [open, setOpen] = useState(true);
  const { pages, beginCreation } = useWindowCreationPages({
    workspaces: available,
    open,
    onOpenPane,
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        tabs={[]}
        onSelectTab={vi.fn()}
        actions={[
          {
            id: "terminal",
            label: "Terminal",
            group: "Browse",
            onSelect: () => ({ page: "terminals" }),
          },
          {
            id: "projects",
            label: "Projects",
            group: "Browse",
            onSelect: () => ({ page: "projects" }),
          },
        ]}
        pages={{
          ...pages,
          terminals: {
            title: "Terminal",
            actions: [
              {
                id: "new",
                label: "Create terminal",
                group: "Terminal",
                onSelect: () => beginCreation("terminal"),
              },
            ],
          },
          projects: {
            title: "Projects",
            actions: [
              {
                id: "new-project",
                label: "New project",
                group: "Projects",
                onSelect: () => beginCreation("project"),
              },
            ],
          },
        }}
      />
    </>
  );
}
const type = (text: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
const choose = (name: string) =>
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${name}`) }));
async function enter() {
  await waitFor(() =>
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')).not.toBeNull(),
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
}
function terminal() {
  choose("Terminal");
  choose("Create terminal");
}
async function project() {
  choose("Projects");
  choose("New project");
  type("kethalia");
  await enter();
  await screen.findByLabelText("Repository");
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("nested command creation", () => {
  it("keeps the typed creation draft when the global search source still publishes an older query", async () => {
    const submit = vi.fn();
    const renderPalette = (searchValue: string) => (
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        tabs={[]}
        onSelectTab={vi.fn()}
        searchValue={searchValue}
        onSearchValueChange={vi.fn()}
        actions={[
          {
            id: "new",
            label: "Create terminal",
            group: "Terminals",
            onSelect: () => ({ page: "create" }),
          },
        ]}
        pages={{
          create: {
            title: "Create terminal",
            actions: [],
            input: {
              label: "Session name",
              maxLength: 200,
              submitLabel: "Create terminal",
              pendingLabel: "Opening",
              onSubmit: submit,
            },
          },
        }}
      />
    );
    const view = render(renderPalette(""));
    choose("Create terminal");
    type("keyboard-check");
    expect(screen.getByLabelText("Session name")).toHaveValue("keyboard-check");
    view.rerender(renderPalette("key"));
    expect(screen.getByLabelText("Session name")).toHaveValue("keyboard-check");
    await enter();
    expect(submit).toHaveBeenCalledExactlyOnceWith("keyboard-check");
  });

  it("keeps category navigation and name entry inside one command dialog and restores the query on Back", async () => {
    render(<Harness onOpenPane={vi.fn()} />);
    type("term");
    choose("Terminal");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("combobox")).toHaveValue("");
    choose("Create terminal");
    type("draft-name");
    choose("Workspace:");
    expect(screen.queryByRole("option", { name: "stopped" })).toBeNull();
    choose("helper");
    expect(screen.getByLabelText("Session name")).toHaveValue("draft-name");
    expect(screen.getByRole("option", { name: /Workspace: helper/ })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.getByRole("combobox")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("combobox")).toHaveValue("term");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("creates once with Enter in the selected workspace, shows progress and opens the returned session", async () => {
    const onOpenPane = vi.fn();
    render(<Harness onOpenPane={onOpenPane} />);
    terminal();
    choose("Workspace:");
    choose("helper");
    type("my-session");
    let finish!: (value: unknown) => void;
    mocks.session.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await enter();
    await enter();
    expect(mocks.session).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "helper",
      sessionName: "my-session",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Opening session");
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.getByLabelText("Session name")).toHaveValue("my-session");
    await act(async () => finish({ data: { name: "my-session" } }));
    expect(onOpenPane).toHaveBeenCalledWith({
      kind: "terminal",
      workspaceId: "helper",
      sessionName: "my-session",
      label: "my-session",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Reopen"));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
  it.each([
    "",
    "bad/name",
    "bad name",
    "git-clone-reserved",
  ])("rejects invalid terminal names: %s", async (name) => {
    render(<Harness onOpenPane={vi.fn()} />);
    terminal();
    type(name);
    await enter();
    await screen.findByRole("alert");
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("collects owner then repository, lets Back edit the owner, and clones only on final Enter", async () => {
    const onOpenPane = vi.fn();
    render(<Harness onOpenPane={onOpenPane} />);
    await project();
    expect(mocks.clone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Organization or owner")).toHaveValue("kethalia");
    type("another-owner");
    await enter();
    await screen.findByLabelText("Repository");
    type("hive");
    const pane = { kind: "terminal", workspaceId: "dev", sessionName: "project", label: "hive" };
    mocks.clone.mockResolvedValue({ data: pane });
    await enter();
    await waitFor(() => expect(onOpenPane).toHaveBeenCalledExactlyOnceWith(pane));
    expect(mocks.clone).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "dev",
      organization: "another-owner",
      repository: "hive",
    });
  });
  it("keeps a failed clone's input available for correction and retry", async () => {
    const onOpenPane = vi.fn();
    render(<Harness onOpenPane={onOpenPane} />);
    await project();
    type("private");
    mocks.clone.mockResolvedValue({ serverError: "Repository access denied" });
    await enter();
    expect(await screen.findByRole("alert")).toHaveTextContent("Repository access denied");
    expect(screen.getByLabelText("Repository")).toHaveValue("private");
    expect(onOpenPane).not.toHaveBeenCalled();
    type("public");
    expect(screen.queryByRole("alert")).toBeNull();
    mocks.clone.mockResolvedValue({
      data: { kind: "terminal", workspaceId: "dev", sessionName: "project", label: "public" },
    });
    await enter();
    await waitFor(() => expect(onOpenPane).toHaveBeenCalledOnce());
  });
  it("validates project owner and repository before sending a clone request", async () => {
    render(<Harness onOpenPane={vi.fn()} />);
    choose("Projects");
    choose("New project");
    type("bad/owner");
    await enter();
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub organization or owner");
    type("kethalia");
    await enter();
    await screen.findByLabelText("Repository");
    type("../hive");
    await enter();
    expect(await screen.findByRole("alert")).toHaveTextContent("without a URL or path");
    expect(mocks.clone).not.toHaveBeenCalled();
  });
  it("does not reopen a window if the workspace unmounts during creation", async () => {
    const onOpenPane = vi.fn();
    const view = render(<Harness onOpenPane={onOpenPane} />);
    terminal();
    type("pending");
    let finish!: (result: unknown) => void;
    mocks.session.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await enter();
    view.unmount();
    await act(async () => finish({ data: { name: "pending" } }));
    expect(onOpenPane).not.toHaveBeenCalled();
  });
  it("refuses a chosen workspace that stopped while naming the terminal", async () => {
    const onOpenPane = vi.fn();
    const view = render(<Harness onOpenPane={onOpenPane} />);
    terminal();
    choose("Workspace:");
    choose("helper");
    type("example");
    view.rerender(
      <Harness onOpenPane={onOpenPane} available={workspaces.filter((w) => w.id !== "helper")} />,
    );
    await enter();
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a running");
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it.each([
    "terminal",
    "project owner",
    "project repository",
  ])("requires an explicit replacement if the default workspace stops during %s entry", async (stage) => {
    const onOpenPane = vi.fn();
    const view = render(<Harness onOpenPane={onOpenPane} />);
    if (stage === "terminal") terminal();
    else if (stage === "project repository") await project();
    else {
      choose("Projects");
      choose("New project");
    }
    type(stage === "project owner" ? "kethalia" : "hive");
    const available = workspaces.map((w) =>
      w.id === "dev" ? { ...w, latest_build: { ...w.latest_build, status: "stopped" } } : w,
    ) as CoderWorkspace[];
    view.rerender(<Harness onOpenPane={onOpenPane} available={available} />);
    if (stage === "project owner") {
      await enter();
      await screen.findByLabelText("Repository");
      type("hive");
    }
    await enter();
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a running");
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.clone).not.toHaveBeenCalled();
    expect(onOpenPane).not.toHaveBeenCalled();

    choose("Choose a running workspace");
    choose("helper");
    expect(screen.getByRole("combobox")).toHaveValue("hive");
    const pane = { kind: "terminal", workspaceId: "helper", sessionName: "hive", label: "hive" };
    mocks.session.mockResolvedValue({ data: { name: "hive" } });
    mocks.clone.mockResolvedValue({ data: pane });
    await enter();
    await waitFor(() => expect(onOpenPane).toHaveBeenCalledExactlyOnceWith(pane));
    if (stage === "terminal") {
      expect(mocks.session).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "helper",
        sessionName: "hive",
      });
    } else {
      expect(mocks.clone).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "helper",
        organization: "kethalia",
        repository: "hive",
      });
    }
  });
  it("chooses the default when creation starts, not when search opens", () => {
    const onOpenPane = vi.fn();
    const view = render(<Harness onOpenPane={onOpenPane} />);
    view.rerender(<Harness onOpenPane={onOpenPane} available={[workspaces[1]]} />);
    terminal();
    expect(screen.getByRole("option", { name: /Workspace: helper/ })).toBeVisible();
  });
  it("does not select a newly running workspace in an existing creation flow", async () => {
    const onOpenPane = vi.fn();
    const view = render(<Harness onOpenPane={onOpenPane} available={[]} />);
    terminal();
    type("example");
    view.rerender(<Harness onOpenPane={onOpenPane} />);
    await enter();
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a running");
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
