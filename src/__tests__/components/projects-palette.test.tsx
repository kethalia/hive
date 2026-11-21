// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/terminal/CommandPalette";
import { useProjectsPalette } from "@/hooks/useProjectsPalette";
import type { CoderWorkspace } from "@/lib/coder/types";

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
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.resetAllMocks();
});

it("browses GitHub repositories in the existing palette and opens the selected terminal with Enter", async () => {
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
  const onOpenProject = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    const [query, setQuery] = useState("");
    const { browse, pages } = useProjectsPalette({
      enabled: true,
      open,
      query,
      workspaces: [workspace],
      onStart: vi.fn(),
      onOpenProject,
    });
    return (
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        actions={browse ? [browse] : []}
        pages={pages}
        tabs={[]}
        onSelectTab={vi.fn()}
        onSearchValueChange={setQuery}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("option", { name: /projects/i }));
  await screen.findByRole("option", { name: /owner\/repo/i });
  expect(onOpenProject).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "owner/repo" } });
  await waitFor(() =>
    expect(screen.getByRole("option", { name: /owner\/repo/i })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(onOpenProject).toHaveBeenCalledWith({
    workspaceId: "workspace",
    buildId: "build",
    repositoryId: "34",
    providerAccountId: "12",
    fullName: "owner/repo",
  });
});
