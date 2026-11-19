import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAction: vi.fn(),
  listWorkspacesAction: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`Redirect to ${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/actions", () => ({ getSessionAction: mocks.getSessionAction }));
vi.mock("@/lib/actions/workspaces", () => ({ listWorkspacesAction: mocks.listWorkspacesAction }));
vi.mock("@/components/workspaces/GeneralWorkspace", () => ({ GeneralWorkspace: () => null }));

import WorkspacesPage from "@/app/(dashboard)/workspaces/page";

describe("workspace sign-in", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a visitor whose session can no longer be read to the sign-in page", async () => {
    mocks.getSessionAction.mockResolvedValue({ serverError: "Not authenticated" });
    mocks.listWorkspacesAction.mockResolvedValue({ serverError: "Not authenticated" });

    const workspaceContent = WorkspacesPage().props.children;
    await expect(workspaceContent.type()).rejects.toThrow("Redirect to /login");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/login");
  });

  it("keeps an authenticated visitor on the workspace when the list fails", async () => {
    mocks.getSessionAction.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.listWorkspacesAction.mockResolvedValue({ serverError: "Workspace list unavailable" });

    const workspaceContent = WorkspacesPage().props.children;
    const page = await workspaceContent.type();
    expect(page.props).toEqual({
      userId: "user-1",
      initialWorkspaces: [],
      error: "Workspace list unavailable",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
