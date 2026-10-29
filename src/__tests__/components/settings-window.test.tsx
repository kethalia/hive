// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/dynamic", async () => ({
  default: (await import("next/dist/shared/lib/app-dynamic")).default,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/components/runtime-config-provider", () => ({ useRuntimeConfig: () => ({}) }));
vi.mock("@/components/workspaces/TerminalSessionFrame", () => ({
  TerminalSessionFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/app-update-settings", () => ({
  AppUpdateSettings: () => <p>App update controls</p>,
}));
vi.mock("@/components/notification-settings", () => ({
  NotificationSettings: (props: unknown) => (
    <output data-testid="notifications">{JSON.stringify(props)}</output>
  ),
}));

import { HiveWorkspacePane } from "@/components/workspaces/HiveWorkspacePane";

const dto = {
  email: "owner@example.com",
  coderUrl: "https://coder.example.com",
  connectedWorkspaceIds: ["one"],
  pendingWorkspaceIds: ["one"],
  workspaces: [{ id: "one", name: "Software", running: true }],
  workspaceError: false,
};
let client: QueryClient;
function tree(userId = "owner") {
  return (
    <QueryClientProvider client={client}>
      <HiveWorkspacePane
        pane={{ id: "settings", kind: "hive", tool: "settings", label: "Settings" }}
        userId={userId}
        workspaces={[]}
        active
        visible
        launchRequest={0}
        onActivate={() => {}}
        onClose={() => {}}
        onWorkspaceChange={() => {}}
        onOpenSession={() => {}}
      />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async () => Response.json(dto));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

describe("portable Settings pane", () => {
  it("loads typed owner data with no-store and retains notification props and normal Sign out UI", async () => {
    render(tree());
    expect(await screen.findByText(dto.email)).toBeVisible();
    expect(mocks.fetch.mock.calls[0][0]).toBe("/api/settings/window");
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(mocks.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(screen.getByTestId("notifications").textContent!)).toEqual({
      connectedWorkspaceIds: dto.connectedWorkspaceIds,
      pendingWorkspaceIds: dto.pendingWorkspaceIds,
      workspaces: dto.workspaces,
      workspaceError: false,
      embedded: true,
    });
    mocks.fetch.mockResolvedValueOnce(Response.json({ success: true }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/login"));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.lastCall).toEqual(["/api/auth/logout", { method: "POST" }]);
  });
  it.each([
    401, 503,
  ])("shows a safe retry on HTTP %i without automatic retry or upstream text", async (status) => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ error: "private upstream failure" }, { status }),
    );
    render(tree());
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings are unavailable.");
    expect(screen.queryByText(/private upstream/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(dto.email)).toBeVisible();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed or extra credential-bearing payload fields", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...dto, ciphertext: "private-token" }));
    render(tree());
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings are unavailable.");
    expect(screen.queryByText(dto.email)).toBeNull();
    expect(document.body.textContent).not.toContain("private-token");
  });
  it("reports network failure without reflecting provider details", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("private-runtime-details"));
    render(tree());
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings are unavailable.");
    expect(document.body.textContent).not.toContain("private-runtime-details");
  });
  it("cancels an in-flight settings request when the pane closes", async () => {
    let requestSignal: AbortSignal | undefined;
    mocks.fetch.mockImplementation((_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    });
    const view = render(tree());
    await waitFor(() => expect(requestSignal).toBeDefined());
    expect(requestSignal?.aborted).toBe(false);
    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });
  it("does not display cached Settings from a different signed-in owner", async () => {
    const view = render(tree());
    expect(await screen.findByText(dto.email)).toBeVisible();
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ error: "not_authenticated" }, { status: 401 }),
    );
    view.rerender(tree("second-owner"));
    expect(screen.queryByText(dto.email)).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings are unavailable.");
  });
});
