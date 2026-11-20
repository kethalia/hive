// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectBrowser } from "@/components/projects/ProjectBrowser";

function page(number = 1, nextPage: number | null = null, name = "hive", id = "42") {
  return {
    schemaVersion: 1,
    provider: "github",
    providerAccountId: "123",
    page: number,
    perPage: 100,
    nextPage,
    repositories: [
      {
        provider: "github",
        providerRepositoryId: id,
        nodeId: "R_42",
        fullName: `owner/${name}`,
        owner: "owner",
        name,
        defaultBranch: "main",
        private: true,
        archived: false,
        htmlUrl: `https://github.com/owner/${name}`,
        permissions: { pull: true, push: false, admin: false },
      },
    ],
  };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(page()))));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("project browser", () => {
  it("does not activate project discovery by default", () => {
    render(<ProjectBrowser workspaceId="workspace-1" />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Project discovery is not enabled.")).toBeInTheDocument();
  });
  it("loads metadata, searches loaded pages and never requests a checkout", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(page(1, 2)))
      .mockResolvedValueOnce(response(page(2, null, "second", "43")));
    render(<ProjectBrowser workspaceId="workspace-1" enabled />);
    expect(await screen.findByRole("link", { name: "owner/hive" })).toHaveAttribute(
      "href",
      "https://github.com/owner/hive",
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
    expect(await screen.findByRole("link", { name: "owner/second" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search loaded repositories"), {
      target: { value: "second" },
    });
    expect(screen.queryByRole("link", { name: "owner/hive" })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      "/api/projects?workspaceId=workspace-1&page=1&perPage=100",
      "/api/projects?workspaceId=workspace-1&page=2&perPage=100",
    ]);
  });
  it("retains a page-two search during focus refresh and publishes updated pages together", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(page(1, 2)))
      .mockResolvedValueOnce(response(page(2, null, "second", "43")))
      .mockResolvedValueOnce(response(page(1, 2, "new-first")))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
    render(<ProjectBrowser workspaceId="workspace-1" enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));
    await screen.findByRole("link", { name: "owner/second" });
    const search = screen.getByLabelText("Search loaded repositories");
    fireEvent.change(search, { target: { value: "second" } });
    fireEvent.focus(window);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("link", { name: "owner/second" })).toBeInTheDocument();
    fireEvent.focus(window);
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => finish(response(page(2, 3, "second-renamed", "43"))));
    expect(search).toHaveValue("second");
    expect(screen.getByRole("link", { name: "owner/second-renamed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more repositories" })).toBeEnabled();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("link", { name: "owner/new-first" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "owner/hive" })).not.toBeInTheDocument();
  });

  it("retains confirmed pages, search, and pagination when a background refresh fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(page(1, 2)))
      .mockResolvedValueOnce(response(page(2, 3, "second", "43")))
      .mockResolvedValueOnce(response(page(1, 2, "unconfirmed")))
      .mockResolvedValueOnce(response({ error: "github_rate_limited" }, 502))
      .mockResolvedValueOnce(response(page(1, 2, "new-first")))
      .mockResolvedValueOnce(response(page(2, 3, "second-renamed", "43")));
    render(<ProjectBrowser workspaceId="workspace-1" enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));
    await screen.findByRole("link", { name: "owner/second" });
    const search = screen.getByLabelText("Search loaded repositories");
    fireEvent.change(search, { target: { value: "second" } });
    fireEvent.focus(window);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Showing the last confirmed repositories",
    );
    expect(search).toHaveValue("second");
    expect(screen.getByRole("link", { name: "owner/second" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Load more repositories" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("link", { name: "owner/second-renamed" })).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("link", { name: "owner/new-first" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "owner/unconfirmed" })).not.toBeInTheDocument();
  });

  it.each([
    [() => response({ error: "github_auth_required" }, 401), "Connect or reconnect GitHub"],
    [() => response({ error: "github_permission_denied" }, 502), "GitHub access was denied"],
    [() => new Response("Not authenticated", { status: 401 }), "Could not load repositories"],
    [() => response({ ...page(2), providerAccountId: "456" }), "GitHub account changed"],
  ] as const)("clears every page when a later refresh response loses the original identity", async (failure, message) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(page(1, 2)))
      .mockResolvedValueOnce(response(page(2, null, "second", "43")))
      .mockResolvedValueOnce(response(page(1, 2, "updated")))
      .mockResolvedValueOnce(failure());
    render(<ProjectBrowser workspaceId="workspace-1" enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));
    await screen.findByRole("link", { name: "owner/second" });
    fireEvent.focus(window);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
  it("clears all loaded metadata when GitHub access is revoked", async () => {
    render(<ProjectBrowser workspaceId="workspace-1" enabled />);
    await screen.findByRole("link", { name: "owner/hive" });
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "github_auth_required" }, 401));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect or reconnect GitHub");
    expect(screen.queryByRole("link", { name: "owner/hive" })).not.toBeInTheDocument();
  });

  it("rejects cross-account pagination and clears the old account's repositories", async () => {
    const other = { ...page(2, null, "other-account", "43"), providerAccountId: "456" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(page(1, 2)))
      .mockResolvedValueOnce(response(other));
    render(<ProjectBrowser workspaceId="workspace-1" enabled />);
    await screen.findByRole("link", { name: "owner/hive" });
    fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub account changed");
    expect(screen.queryByRole("link", { name: "owner/hive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "owner/other-account" })).not.toBeInTheDocument();
  });
  it("does not render a late response from a previous workspace", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(response(page(1, null, "current")));
    const view = render(<ProjectBrowser workspaceId="workspace-old" enabled />);
    view.rerender(<ProjectBrowser workspaceId="workspace-current" enabled />);
    await screen.findByRole("link", { name: "owner/current" });
    await act(async () => resolve(response(page(1, null, "old"))));
    expect(screen.queryByRole("link", { name: "owner/old" })).not.toBeInTheDocument();
  });
  it("clears hidden data and suppresses arbitrary server prose", async () => {
    const view = render(<ProjectBrowser workspaceId="workspace-1" enabled />);
    await screen.findByRole("link", { name: "owner/hive" });
    view.rerender(<ProjectBrowser workspaceId="workspace-1" enabled visible={false} />);
    expect(screen.queryByRole("link", { name: "owner/hive" })).not.toBeInTheDocument();
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "private-secret-prose" }, 502));
    view.rerender(<ProjectBrowser workspaceId="workspace-1" enabled />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not load repositories"),
    );
    expect(screen.queryByText("private-secret-prose")).not.toBeInTheDocument();
  });
  it.each([
    ["workspace_unavailable", "Review workspace setup", "workspace"],
    ["github_auth_required", "Manage GitHub connection", "account"],
  ] as const)("provides the right setup action for %s without cloning", async (code, label, kind) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: code }, 502));
    const setup = vi.fn();
    render(<ProjectBrowser workspaceId="workspace-1" enabled onSetup={setup} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(setup).toHaveBeenCalledWith(kind);
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      "/api/projects?workspaceId=workspace-1&page=1&perPage=100",
    ]);
  });
});
