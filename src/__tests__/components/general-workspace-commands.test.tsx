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
  { id: "software", name: "ai-dev-01", latest_build: { id: "build-1", status: "running" } },
  { id: "browser", name: "browser-testing", latest_build: { id: "build-2", status: "running" } },
  { id: "infra", name: "infrastructure", latest_build: { id: "build-3", status: "stopped" } },
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
    const props = { workspaces, onOpenPane: vi.fn(), onError: vi.fn() };
    const hook = renderHook((value) => useGeneralWorkspaceCommands(value), { initialProps: props });
    return { ...hook, ...props };
  }
  async function open() {
    act(() => source().onOpenChange!(true));
    await waitFor(() => expect(action("session:software:main")).toBeDefined());
  }
  it("discovers running workspaces when search opens, without refetching on each query or poll", async () => {
    const { rerender, onOpenPane, onError } = setup();
    expect(mocks.sessions).not.toHaveBeenCalled();
    await open();
    expect(mocks.sessions.mock.calls).toEqual([
      [{ workspaceId: "browser" }],
      [{ workspaceId: "software" }],
    ]);
    search("hive");
    rerender({ workspaces: structuredClone(workspaces), onOpenPane, onError });
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
});
