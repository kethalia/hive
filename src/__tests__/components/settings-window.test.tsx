// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/discovery/transport", () => ({ readDiscovery: async () => [] }));

import { DiscoveryProvider } from "@/components/discovery/DiscoveryProvider";
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
function tree(userId = "owner", launchRequest = 0) {
  return (
    <QueryClientProvider client={client}>
      <HiveWorkspacePane
        pane={{ id: "settings", kind: "hive", tool: "settings", label: "Settings" }}
        userId={userId}
        workspaces={[]}
        active
        visible
        launchRequest={launchRequest}
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
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

describe("portable Settings pane", () => {
  const oauth = {
    source: "oauth",
    credentialId: "10000000-0000-4000-8000-000000000001",
    version: 3,
    status: "connected",
  };
  it.each([
    "acknowledged",
    "unconfirmed",
    "lost",
  ])("keeps %s outcome through real cache clearing, parent resize/rerender and stale focus without preserving private data", async (outcome) => {
    let liveClient: QueryClient | undefined;
    function Probe() {
      liveClient = useQueryClient();
      return null;
    }
    let disconnected = false,
      settingsReads = 0;
    mocks.fetch.mockImplementation(async (url) => {
      if (url === "/api/auth/coder/disconnect") {
        disconnected = true;
        if (outcome === "lost") throw new Error("private lost acknowledgement");
        return Response.json({
          status: "disconnected",
          providerRevocation: outcome,
          currentConnection: "disconnected",
        });
      }
      settingsReads++;
      return disconnected
        ? Response.json({ error: "not_authenticated" }, { status: 401 })
        : Response.json({ ...dto, coderConnection: oauth });
    });
    const live = (userId = "owner", launchRequest = 0) => (
      <DiscoveryProvider>
        <Probe />
        {tree(userId, launchRequest).props.children}
      </DiscoveryProvider>
    );
    const view = render(live());
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Coder" }));
    if (!liveClient) throw new Error("DiscoveryProvider client was not mounted");
    const scopedClient = liveClient;
    scopedClient.setQueryData(["private-other", "owner"], { email: "private cached account" });
    expect(scopedClient.getQueryData(["private-other", "owner"])).toEqual({
      email: "private cached account",
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    const notice =
      outcome === "lost"
        ? "The disconnect outcome is unknown."
        : "This Coder connection was disconnected.";
    if (outcome === "lost") expect(await screen.findByRole("alert")).toHaveTextContent(notice);
    else expect(await screen.findByText(notice)).toBeVisible();
    expect(scopedClient.getQueryData(["private-other", "owner"])).toBeUndefined();
    expect(scopedClient.getQueryData(["settings-window", "owner"])).toBeUndefined();
    expect(screen.queryByText(dto.email)).toBeNull();
    const denied = await fetch("/api/settings/window", { credentials: "same-origin" });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "not_authenticated" });
    view.rerender(live("owner", 1));
    fireEvent(window, new Event("resize"));
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31000);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();
    expect(settingsReads).toBe(2); // Initial data and explicit 401, no obsolete query refetch.
    if (outcome === "lost") expect(screen.getByRole("alert")).toHaveTextContent(notice);
    else expect(screen.getByText(notice)).toBeVisible();
    expect(screen.queryByText("Settings are unavailable.")).toBeNull();
    // A new owner must authenticate/read anew, never inherit the notice or DTO.
    let nextEmail = "second@example.com";
    mocks.fetch.mockImplementation(async () =>
      Response.json({ ...dto, email: nextEmail, coderConnection: oauth }),
    );
    view.rerender(live("second-owner", 2));
    expect(await screen.findByText("second@example.com")).toBeVisible();
    expect(screen.queryByText("This Coder connection was disconnected.")).toBeNull();
    expect(screen.queryByText(dto.email)).toBeNull();
    nextEmail = "owner-returned@example.com";
    view.rerender(live("owner", 3));
    expect(await screen.findByText(nextEmail)).toBeVisible();
    expect(screen.queryByText("This Coder connection was disconnected.")).toBeNull();
  });
  it("lets the owner cancel disconnect confirmation without sending a mutation", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...dto, coderConnection: oauth }));
    render(tree());
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Coder" }));
    expect(screen.getByRole("group", { name: "Confirm Coder disconnect" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm disconnect" })).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    "acknowledged",
    "unconfirmed",
  ])("submits once, reports scoped %s result and preserves newer-login navigation", async (providerRevocation) => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...dto, coderConnection: oauth }));
    let resolve!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(tree());
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Coder" }));
    const button = screen.getByRole("button", { name: "Confirm disconnect" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(mocks.fetch.mock.lastCall?.[0]).toBe("/api/auth/coder/disconnect");
    expect(JSON.parse(mocks.fetch.mock.lastCall?.[1].body)).toEqual({
      credentialId: oauth.credentialId,
      version: 3,
    });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
    resolve(
      Response.json({ status: "disconnected", providerRevocation, currentConnection: "changed" }),
    );
    expect(await screen.findByText("This Coder connection was disconnected.")).toBeVisible();
    expect(
      screen.getByText(/The connection changed. Refresh Hive to see its current status./),
    ).toBeVisible();
    expect(
      screen.getByText(
        providerRevocation === "acknowledged"
          ? "Coder accepted its revocation request."
          : "Coder revocation could not be confirmed.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Refresh Hive" })).toHaveAttribute(
      "href",
      "/workspaces",
    );
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("does not retry or claim success after a lost disconnect response", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...dto, coderConnection: oauth }));
    mocks.fetch.mockRejectedValueOnce(new Error("private provider details"));
    render(tree());
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Coder" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The disconnect outcome is unknown.",
    );
    expect(screen.queryByText("This Coder connection was disconnected.")).toBeNull();
    expect(document.body.textContent).not.toContain("private provider details");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
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
