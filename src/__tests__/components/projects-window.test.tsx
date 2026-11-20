// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectsWindow } from "@/components/projects/ProjectsWindow";
import { manageProjectCheckoutAction } from "@/lib/actions/project-checkout";
import type { CoderWorkspace } from "@/lib/coder/types";

vi.mock("@/lib/actions/project-checkout", () => ({ manageProjectCheckoutAction: vi.fn() }));

const workspace = {
  id: "workspace",
  name: "Dev",
  owner_name: "owner",
  template_id: "test",
  latest_build: { id: "build", status: "running", job: { status: "succeeded", error: "" } },
} satisfies CoderWorkspace;
const repository = {
  provider: "github",
  providerRepositoryId: "34",
  nodeId: "repo",
  fullName: "owner/repo",
  name: "repo",
  owner: "owner",
  defaultBranch: "main",
  archived: false,
  private: true,
  htmlUrl: "https://github.com/owner/repo",
  permissions: { pull: true, push: true, admin: false },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("opens available repositories in Codex and asks before cleanup", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        schemaVersion: 1,
        provider: "github",
        providerAccountId: "12",
        repositories: [repository],
        page: 1,
        perPage: 100,
        nextPage: null,
      }),
    ),
  );
  const action = vi.mocked(manageProjectCheckoutAction);
  action.mockResolvedValueOnce({
    data: { status: "opened", fullName: repository.fullName, sessionName: "session" },
  });
  action.mockResolvedValueOnce({ serverError: "This checkout is in use." });
  const onOpenSession = vi.fn();
  render(
    <ProjectsWindow
      visible
      workspace={workspace}
      workspaces={[workspace]}
      navigation={{ collapsed: false, id: "projects" }}
      onStartWorkspace={vi.fn()}
      onWorkspaceChange={vi.fn()}
      onOpenSession={onOpenSession}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Open owner/repo in Codex" }));
  await waitFor(() =>
    expect(onOpenSession).toHaveBeenCalledWith("workspace", "session", "Codex · owner/repo"),
  );
  const scope = {
    workspaceId: "workspace",
    buildId: "build",
    repositoryId: "34",
    providerAccountId: "12",
  };
  expect(action).toHaveBeenCalledWith({ action: "open", ...scope });

  fireEvent.click(screen.getByText("Repository details"));
  fireEvent.click(screen.getByRole("button", { name: "Clean up checkout" }));
  await screen.findByRole("dialog", { name: "Clean up project checkout?" });
  expect(action).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Remove checkout" }));
  expect(action).toHaveBeenLastCalledWith({ action: "cleanup", ...scope });
  expect(await screen.findByRole("alert")).toHaveTextContent("This checkout is in use.");
});
