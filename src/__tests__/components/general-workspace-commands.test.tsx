// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGeneralWorkspaceCommands } from "@/hooks/useGeneralWorkspaceCommands";
import type { CoderWorkspace } from "@/lib/coder/types";
import { getGlobalCommandPaletteSources } from "@/lib/terminal/global-command-palette";

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  clones: vi.fn(),
  resolve: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/actions/workspaces", () => ({
  getWorkspaceSessionsAction: mocks.sessions,
  createSessionAction: mocks.create,
}));
vi.mock("@/lib/actions/git-clones", () => ({
  listGitClonesAction: mocks.clones,
  resolveGitCloneTerminalAction: mocks.resolve,
}));
const repository = {
  kind: "repository",
  id: "repo",
  label: "hive",
  cloneSessionKey: "git-clone:projects/kethalia/hive",
  relativePath: "projects/kethalia/hive",
};
const workspaces = [
  {
    id: "software",
    name: "ai-dev-01",
    template_name: "ai-dev-k8s",
    latest_build: { id: "build-1", status: "running" },
  },
  {
    id: "browser",
    name: "browser-testing",
    template_name: "browser-testing",
    latest_build: { id: "build-2", status: "running" },
  },
  {
    id: "infra",
    name: "infrastructure",
    template_name: "infrastructure",
    latest_build: { id: "build-3", status: "stopped" },
  },
] as CoderWorkspace[];
const source = () =>
  getGlobalCommandPaletteSources().find((item) => item.id === "general-workspace")!;
const action = (id: string) => source().actions!.find((item) => item.id === id)!;
const search = (value: string) => act(() => source().onSearchValueChange!(value));

describe("general workspace search", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sessions.mockResolvedValue({ data: [{ name: "main" }, { name: "git-clone-hive" }] });
    mocks.clones.mockResolvedValue({ data: { ok: true, tree: { nodes: [repository] } } });
    mocks.resolve.mockResolvedValue({
      data: {
        sessionName: "git-clone-hive",
        cloneProof: "secret",
        clonePath: "/home/coder/projects/kethalia/hive",
      },
    });
    mocks.create.mockImplementation(async ({ sessionName }) => ({
      data: { name: sessionName ?? "generated" },
    }));
  });
  function setup() {
    const props = {
      workspaces,
      onOpenPane: vi.fn(),
      onError: vi.fn(),
      onStart: vi.fn().mockResolvedValue(undefined),
      onAgents: vi.fn(),
    };
    const hook = renderHook((value) => useGeneralWorkspaceCommands(value), { initialProps: props });
    return { ...hook, ...props };
  }
  async function open() {
    act(() => source().onOpenChange!(true));
    await waitFor(() => expect(action("session:software:main")).toBeDefined());
  }
  it("discovers running workspaces when search opens, without refetching on each query or poll", async () => {
    const { rerender, onOpenPane, onError, onStart, onAgents } = setup();
    expect(mocks.sessions).not.toHaveBeenCalled();
    await open();
    expect(mocks.sessions.mock.calls).toEqual([
      [{ workspaceId: "browser" }],
      [{ workspaceId: "software" }],
    ]);
    search("hive");
    rerender({ workspaces: structuredClone(workspaces), onOpenPane, onError, onStart, onAgents });
    expect(mocks.sessions).toHaveBeenCalledTimes(2);
    expect(action("new-terminal:infra")).toBeUndefined();
  });
  it("creates the typed name in the chosen workspace, and resumes existing names", async () => {
    const { onOpenPane } = setup();
    await open();
    search(" test-runner ");
    expect(action("new-terminal:browser").description).toBe("browser-testing");
    await act(async () => action("new-terminal:browser").onSelect());
    expect(mocks.create).toHaveBeenCalledWith({
      workspaceId: "browser",
      sessionName: "test-runner",
    });
    expect(onOpenPane).toHaveBeenCalledWith({
      kind: "terminal",
      workspaceId: "browser",
      sessionName: "test-runner",
      label: "test-runner",
    });
    search("main");
    expect(action("new-terminal:software")).toBeUndefined();
    act(() => action("session:software:main").onSelect());
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it.each([
    "bad name",
    "bad/name",
    "git-clone-reserved",
  ])("disables invalid or reserved names: %s", async (name) => {
    setup();
    await open();
    search(name);
    expect(action("new-terminal:software").disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("opens repository terminals with clone identity, without persisting credentials", async () => {
    const { onOpenPane } = setup();
    await open();
    search("hive");
    expect(action("session:software:git-clone-hive")).toBeUndefined();
    await act(async () =>
      action("repository:software:git-clone:projects/kethalia/hive").onSelect(),
    );
    expect(mocks.resolve).toHaveBeenCalledWith({
      workspaceId: "software",
      cloneSessionKey: "git-clone:projects/kethalia/hive",
      relativePath: "projects/kethalia/hive",
    });
    expect(onOpenPane).toHaveBeenCalledWith({
      kind: "terminal",
      workspaceId: "software",
      sessionName: "git-clone-hive",
      label: "hive",
      cloneSessionKey: "git-clone:projects/kethalia/hive",
      relativePath: "projects/kethalia/hive",
    });
  });
  it("shows open failures and prevents duplicate in-flight requests", async () => {
    const { onOpenPane, onError } = setup();
    await open();
    let finish!: (value: unknown) => void;
    mocks.resolve.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const selected = action("repository:software:git-clone:projects/kethalia/hive");
    act(() => {
      selected.onSelect();
      selected.onSelect();
    });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    await act(async () => finish({ serverError: "Repository no longer exists" }));
    expect(onOpenPane).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Repository no longer exists");
  });
  it("keeps successful results on partial discovery failure and retries without closing search", async () => {
    mocks.clones.mockRejectedValueOnce(new Error("offline"));
    setup();
    await open();
    const retry = action("retry-terminals:browser");
    expect(retry.closeOnSelect).toBe(false);
    expect(action("session:browser:main")).toBeDefined();
    act(() => retry.onSelect());
    await waitFor(() =>
      expect(action("repository:browser:git-clone:projects/kethalia/hive")).toBeDefined(),
    );
    expect(action("retry-terminals:browser")).toBeUndefined();
  });
  it("exposes supported apps immediately and opens them in their own workspace", () => {
    const { onOpenPane, onAgents, onStart } = setup();
    expect(source().handlesWorkspaces).toBe(true);
    expect(action("app:software:desktop")).toBeUndefined();
    expect(action("app:browser:code")).toBeUndefined();
    for (const [workspaceId, tool, label] of [
      ["software", "files", "Files"],
      ["software", "code", "VS Code"],
      ["browser", "desktop", "Desktop"],
    ]) {
      act(() => action(`app:${workspaceId}:${tool}`).onSelect());
      expect(onOpenPane).toHaveBeenLastCalledWith({ kind: "app", workspaceId, tool, label });
    }
    act(() => action("agents:browser").onSelect());
    expect(onAgents).toHaveBeenCalledWith("browser");
    expect(onStart).not.toHaveBeenCalled();
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
  it("shows each workspace's results without waiting for slower workspaces", async () => {
    let finish!: (result: unknown) => void;
    mocks.sessions.mockImplementation(({ workspaceId }) =>
      workspaceId === "browser"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ data: [{ name: "main" }] }),
    );
    setup();
    await open();
    expect(action("session:browser:slow")).toBeUndefined();
    expect(action("app:browser:desktop")).toBeDefined();
    await act(async () => finish({ data: [{ name: "slow" }] }));
    expect(action("session:browser:slow")).toBeDefined();
  });
  it("only starts a stopped workspace when selected, keeps search open, then discovers its terminals", async () => {
    const { rerender, onStart, onOpenPane, onError, onAgents } = setup();
    await open();
    expect(onStart).not.toHaveBeenCalled();
    const start = action("start-workspace:infra");
    expect(start.closeOnSelect).toBe(false);
    await act(async () => start.onSelect());
    expect(onStart).toHaveBeenCalledWith("infra");
    expect(onOpenPane).not.toHaveBeenCalled();
    rerender({
      workspaces: workspaces.map((workspace) =>
        workspace.id === "infra"
          ? { ...workspace, latest_build: { ...workspace.latest_build, status: "running" } }
          : workspace,
      ),
      onStart,
      onOpenPane,
      onError,
      onAgents,
    });
    await waitFor(() => expect(action("session:infra:main")).toBeDefined());
    expect(action("start-workspace:infra")).toBeUndefined();
  });
  it("reports start errors in search and prevents duplicate starts", async () => {
    const { onStart } = setup();
    let fail!: (error: Error) => void;
    onStart.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const start = action("start-workspace:infra");
    act(() => {
      start.onSelect();
      start.onSelect();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(action("start-workspace:infra").disabled).toBe(true);
    await act(async () => fail(new Error("Start failed")));
    expect(action("start-workspace:infra").description).toBe("Start failed");
    expect(action("start-workspace:infra").disabled).toBe(false);
  });
  it("does not apply stale discovery results after closing and reopening search", async () => {
    let finish!: (result: unknown) => void;
    mocks.sessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    setup();
    await open();
    act(() => source().onOpenChange!(false));
    await open();
    await act(async () => finish({ data: [{ name: "stale" }] }));
    expect(action("session:browser:stale")).toBeUndefined();
    expect(action("session:browser:main")).toBeDefined();
  });
});
