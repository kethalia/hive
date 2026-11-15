// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAccountCard } from "@/components/workspaces/CodexAccountCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const lifetimeId = "00000000-0000-4000-8000-000000000001";
const status = (state = "signed-out", generation = 0, pending: unknown = null) => ({
  scope: "managed-native",
  lifetimeId,
  generation,
  state,
  pending,
});
it("connects through the fixed route, displays official one-time code, and fences cancel", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status()))
    .mockResolvedValueOnce(
      Response.json(
        status("pending", 1, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 600000,
        }),
      ),
    )
    .mockResolvedValueOnce(Response.json(status("cancelled", 2)));
  vi.stubGlobal("fetch", fetcher);
  render(
    <CodexAccountCard workspaceId="workspace" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Connect Codex" }));
  expect(await screen.findByRole("link", { name: "Open official Codex sign-in" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  expect(screen.getByText("ABCD-1234")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetcher.mock.calls[2][1].body).request).toEqual({
    action: "cancel",
    lifetimeId,
    generation: 1,
  });
});
it("busy state offers status retry without interrupting a native session", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(status("busy"))));
  render(
    <CodexAccountCard workspaceId="workspace" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  expect(await screen.findByText(/Codex is using these credentials/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
});

it("workspace switch immediately hides old device codes and cannot reuse their mutation fence", async () => {
  let reply: (value: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        status("pending", 7, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "OLD-CODE",
          expiresAt: Date.now() + 600000,
        }),
      ),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const view = render(
    <CodexAccountCard workspaceId="old-workspace" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  expect(await screen.findByText("OLD-CODE")).toBeVisible();
  view.rerender(
    <CodexAccountCard workspaceId="new-workspace" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  expect(screen.queryByText("OLD-CODE")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toContain("new-workspace");
  expect(JSON.parse(fetcher.mock.calls[1][1].body).request).toEqual({ action: "status" });
  reply(Response.json(status()));
  expect(await screen.findByRole("button", { name: "Connect Codex" })).toBeVisible();
});

it("sends the selected build for status, reconnect and disconnect", async () => {
  const buildId = "22222222-2222-4222-8222-222222222222";
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status("signed-in", 4)))
    .mockResolvedValueOnce(Response.json(status("signed-in", 5)))
    .mockResolvedValueOnce(Response.json(status("signed-out", 6)));
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId={buildId} />);
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Connect Codex" });
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body))).toEqual([
    { buildId, request: { action: "status" } },
    { buildId, request: { action: "reconnect", lifetimeId, generation: 4 } },
    { buildId, request: { action: "disconnect", lifetimeId, generation: 5 } },
  ]);
});

it("hides codes and drops a late response when the same workspace changes build", async () => {
  let lateReply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        status("pending", 4, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "OLD-CODE",
          expiresAt: Date.now() + 600000,
        }),
      ),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          lateReply = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(status("signed-out", 0)));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<CodexAccountCard workspaceId="workspace" buildId="old-build" />);
  await screen.findByText("OLD-CODE");
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  view.rerender(<CodexAccountCard workspaceId="workspace" buildId="new-build" />);
  expect(screen.queryByText("OLD-CODE")).not.toBeInTheDocument();
  await screen.findByRole("button", { name: "Connect Codex" });
  await act(async () =>
    lateReply(
      Response.json(
        status("pending", 5, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "LATE-CODE",
          expiresAt: Date.now() + 600000,
        }),
      ),
    ),
  );
  expect(screen.queryByText("LATE-CODE")).not.toBeInTheDocument();
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
    buildId: "new-build",
    request: { action: "status" },
  });
});

it("keeps loading and unavailable feedback visible until status can be refreshed", async () => {
  let respond!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(status()));
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId="selected-build" />);
  expect(screen.getByText("Checking Codex connection…")).toBeVisible();
  await act(async () => respond(new Response(null, { status: 404 })));
  expect(await screen.findByText(/Codex connection is unavailable/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await screen.findByRole("button", { name: "Connect Codex" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("distinguishes an unavailable status read from an uncertain account mutation", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(Error("bridge unavailable"))
    .mockResolvedValueOnce(Response.json(status()))
    .mockRejectedValueOnce(Error("mutation acknowledgement lost"));
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId="selected-build" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Account status unavailable. Check workspace bridge setup and refresh.",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  fireEvent.click(await screen.findByRole("button", { name: "Connect Codex" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Account outcome is unknown. Refresh status before trying again.",
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).buildId)).toEqual([
    "selected-build",
    "selected-build",
    "selected-build",
  ]);
});
