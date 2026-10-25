// @vitest-environment jsdom

import { useQueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGeneralWorkspaceCommands } from "@/hooks/useGeneralWorkspaceCommands";
import type { CoderWorkspace } from "@/lib/coder/types";
import { DiscoveryError } from "@/lib/discovery/types";
import { getGlobalCommandPaletteSources } from "@/lib/terminal/global-command-palette";
import { act, cleanup, renderHook, waitFor } from "../helpers/discovery";

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
      onCreate: vi.fn(),
    };
    const hook = renderHook(
      (value) => {
        useGeneralWorkspaceCommands(value);
        return useQueryClient();
      },
      { initialProps: props },
    );
    return { ...hook, ...props };
  }
  async function open() {
    act(() => source().onOpenChange!(true));
    await waitFor(() => expect(action("session:software:main")).toBeDefined());
  }
  it("discovers running workspaces when search opens, without refetching on each query or poll", async () => {
    const { rerender, onOpenPane, onError, onStart, onCreate } = setup();
    expect(mocks.sessions).not.toHaveBeenCalled();
    await open();
    expect(mocks.sessions.mock.calls).toEqual([
      [{ workspaceId: "browser" }],
      [{ workspaceId: "software" }],
    ]);
    search("hive");
    rerender({ workspaces: structuredClone(workspaces), onOpenPane, onError, onStart, onCreate });
    expect(mocks.sessions).toHaveBeenCalledTimes(2);
    expect(action("new-terminal:infra")).toBeUndefined();
  });
  it("offers one creation action first in each group and opens existing sessions directly", async () => {
    const { onCreate, onOpenPane } = setup();
    await open();
    const terminals = source().actions!.filter((a) => a.group === "Terminals");
    const projects = source().actions!.filter((a) => a.group === "Projects");
    expect(terminals[0].label).toBe("New session");
    expect(projects[0].label).toBe("New project");
    act(() => terminals[0].onSelect());
    expect(onCreate).toHaveBeenCalledWith("terminal");
    act(() => projects[0].onSelect());
    expect(onCreate).toHaveBeenCalledWith("project");
    expect(mocks.create).not.toHaveBeenCalled();
    act(() => action("session:software:main").onSelect());
    expect(onOpenPane).toHaveBeenCalledWith({
      kind: "terminal",
      workspaceId: "software",
      sessionName: "main",
      label: "main",
    });
  });
  it("only offers repositories whose name or path contains the query, ignoring case and surrounding spaces", async () => {
    const names = [
      "hive",
      "hive-cache-maintenance",
      "realm-of-chill",
      "rng-request-listener",
      "hyperlane-registry-reference",
      "hawkeye",
      "house-of-slabs",
    ];
    const repositories = names.map((name) => ({
      ...repository,
      id: name,
      label: name,
      relativePath: `projects/kethalia/${name}`,
      cloneSessionKey: `git-clone:projects/kethalia/${name}`,
    }));
    mocks.clones.mockResolvedValue({ data: { ok: true, tree: { nodes: repositories } } });
    setup();
    await open();
    const visibleRepositories = () =>
      source().actions!.filter((item) => item.group === "Projects" && item.id !== "new-project");
    expect(visibleRepositories()).toHaveLength(names.length * 2);

    search(" HIVE ");
    expect(visibleRepositories().map((item) => item.label)).toEqual([
      "hive",
      "hive-cache-maintenance",
      "hive",
      "hive-cache-maintenance",
    ]);
    search("kethalia/HAWK");
    expect(visibleRepositories().map((item) => item.label)).toEqual(["hawkeye", "hawkeye"]);
    search("ai-dev-01");
    expect(visibleRepositories()).toEqual([]);
    search("no-such-repository");
    expect(visibleRepositories()).toEqual([]);
    expect(action("new-terminal").label).toBe("New session");
    search("");
    expect(visibleRepositories()).toHaveLength(names.length * 2);
    expect(mocks.clones).toHaveBeenCalledTimes(2);
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
  it.each([
    "sessions",
    "repositories",
  ])("keeps search snapshots hidden after %s is denied and retries fail", async (resource) => {
    const { result } = setup();
    await open();
    const sessionId = "session:software:main";
    const repositoryId = "repository:software:git-clone:projects/kethalia/hive";
    await waitFor(() => expect(action(repositoryId)).toBeDefined());
    const read = resource === "sessions" ? mocks.sessions : mocks.clones;
    read.mockRejectedValue(new DiscoveryError("denied", 403));
    await act(async () => {
      await result.current.invalidateQueries({ queryKey: ["discovery", resource, "software"] });
    });
    await waitFor(() => expect(action(sessionId)).toBeUndefined());
    expect(action(repositoryId)).toBeUndefined();
    for (const error of [new DiscoveryError("unavailable", 503), new Error("timeout")]) {
      read.mockRejectedValue(error);
      act(() => action("retry-terminals:software").onSelect());
      await waitFor(() =>
        expect(
          result.current.getQueryState(["discovery", resource, "software", "build-1"])?.error
            ?.message,
        ).toBe(error.message),
      );
      expect(action(sessionId)).toBeUndefined();
      expect(action(repositoryId)).toBeUndefined();
    }
    act(() => source().onOpenChange!(false));
    act(() => source().onOpenChange!(true));
    expect(action(sessionId)).toBeUndefined();
    expect(action(repositoryId)).toBeUndefined();
    await waitFor(() => expect(result.current.isFetching()).toBe(0));
    read.mockResolvedValue(
      resource === "sessions"
        ? { data: [{ name: "main" }] }
        : { data: { ok: true, tree: { nodes: [repository] } } },
    );
    act(() => action("retry-terminals:software").onSelect());
    await waitFor(() => expect(action(repositoryId)).toBeDefined());
    expect(action(sessionId)).toBeDefined();
  });
  it("exposes supported apps immediately and opens them in their own workspace", () => {
    const { onOpenPane, onStart } = setup();
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
    expect(source().loadingText).toBe("Loading terminals and repositories…");
    search("hive");
    expect(source().loadingText).toBe("Loading terminals and repositories…");
    await act(async () => finish({ data: [{ name: "slow" }] }));
    await waitFor(() => expect(action("session:browser:slow")).toBeDefined());
    expect(source().loadingText).toBeUndefined();
  });

  it("does not offer retry for a workspace with no sessions or repositories", async () => {
    mocks.sessions.mockResolvedValue({ data: [] });
    mocks.clones.mockResolvedValue({ data: { ok: true, tree: { nodes: [] } } });
    setup();
    act(() => source().onOpenChange!(true));
    await waitFor(() => expect(source().loadingText).toBeUndefined());
    expect(source().actions!.some((item) => item.id.startsWith("retry-terminals:"))).toBe(false);
    expect(action("new-terminal")).toBeDefined();
  });
  it("only starts a stopped workspace when selected, keeps search open, then discovers its terminals", async () => {
    const { rerender, onStart, onOpenPane, onError, onCreate } = setup();
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
      onCreate,
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
  it("does not apply stale discovery results after a workspace rebuild", async () => {
    let finish!: (result: unknown) => void;
    mocks.sessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender, onOpenPane, onError, onStart, onCreate } = setup();
    await open();
    rerender({
      workspaces: workspaces.map((w) =>
        w.id === "browser" ? { ...w, latest_build: { ...w.latest_build, id: "new-build" } } : w,
      ),
      onOpenPane,
      onError,
      onStart,
      onCreate,
    });
    await waitFor(() => expect(action("session:browser:main")).toBeDefined());
    await act(async () => finish({ data: [{ name: "stale" }] }));
    expect(action("session:browser:stale")).toBeUndefined();
    expect(action("session:browser:main")).toBeDefined();
  });
});

vi.mock("@/lib/discovery/transport", () => ({
  readDiscovery: async (resource: string, target: { workspaceId: string }) => {
    const input = { workspaceId: target.workspaceId };
    const result = await (resource === "sessions" ? mocks.sessions(input) : mocks.clones(input));
    if (resource === "sessions" && result?.data) return result.data;
    if (resource === "repositories" && result?.data?.ok) return result.data.tree;
    throw new Error(result?.serverError ?? "Discovery unavailable");
  },
}));
