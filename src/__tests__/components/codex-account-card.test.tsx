// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAccountCard } from "@/components/workspaces/CodexAccountCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  await screen.findByRole("dialog", { name: "Disconnect Codex?" });
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Codex" }));
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

it.each([
  ["workspace_not_enrolled", /Choose a workspace set up for this deployment/],
  ["workspace_bridge_missing", /enable Hive agent tools, and rebuild/],
])("shows the next step for %s", async (error, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error }, { status: 409 })));
  render(<CodexAccountCard workspaceId="workspace" buildId="selected-build" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
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

it("copies the official device code and reports clipboard failure without replaying a mutation", async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("denied"));
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(
      Response.json(
        status("pending", 2, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "COPY-1234",
          expiresAt: Date.now() + 600000,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<CodexAccountCard workspaceId="workspace" buildId="build" />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy code" }));
    expect(await screen.findByText("Sign-in code copied.")).toBeVisible();
    expect(writeText).toHaveBeenCalledWith("COPY-1234");
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Copy failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("hides an expired challenge and reads status before offering another sign-in", async () => {
  let readback!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        status("pending", 3, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "EXPIRED-CODE",
          expiresAt: Date.now() - 1000,
        }),
      ),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          readback = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId="build" />);
  expect(await screen.findByText("Code expired")).toBeVisible();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("EXPIRED-CODE")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open official Codex sign-in" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Connect Codex" })).not.toBeInTheDocument();
  await act(async () => readback(Response.json(status("expired", 4))));
  expect(await screen.findByRole("button", { name: "Connect Codex" })).toBeEnabled();
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).request.action)).toEqual([
    "status",
    "status",
  ]);
});

it("reports sign-in winning a cancellation race and keeps the connected account", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        status("pending", 1, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "RACE-1234",
          expiresAt: Date.now() + 600000,
        }),
      ),
    )
    .mockResolvedValueOnce(Response.json(status("signed-in", 2)));
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId="build" />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
  expect(await screen.findByText("Codex sign-in completed before cancellation.")).toBeVisible();
  expect(screen.getByText("Connected")).toBeVisible();
  expect(screen.queryByText("Codex sign-in cancelled.")).not.toBeInTheDocument();
});

it("captures the disconnect fence and disables confirmation when status changes", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status("signed-in", 4)))
    .mockResolvedValueOnce(Response.json(status("signed-in", 5)))
    .mockResolvedValueOnce(Response.json(status("signed-out", 6)));
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId="build" />);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  await screen.findByRole("dialog", { name: "Disconnect Codex?" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByRole("alert")).toHaveTextContent("account connection changed");
  expect(screen.getByRole("button", { name: "Disconnect Codex" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect Codex" }));
  await screen.findByText("Codex disconnected.");
  expect(JSON.parse(fetcher.mock.calls[2][1].body).request).toEqual({
    action: "disconnect",
    lifetimeId,
    generation: 5,
  });
});

it("keeps signed-in management mounted during refresh errors and separates its busy flag", async () => {
  let reply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status("signed-in", 1)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    )
    .mockRejectedValueOnce(Error("read failed"));
  vi.stubGlobal("fetch", fetcher);
  const tree = (managementBusy: boolean) => (
    <CodexAccountCard workspaceId="workspace" buildId="build" managementBusy={managementBusy}>
      {(current, controls) => (
        <div>
          <input aria-label="Management draft" defaultValue="Saved" />
          <span>Generation {current.generation}</span>
          <button type="button" disabled={controls.busy} onClick={controls.refresh}>
            Refresh from management
          </button>
        </div>
      )}
    </CodexAccountCard>
  );
  const view = render(tree(false));
  const draft = await screen.findByRole("textbox", { name: "Management draft" });
  fireEvent.change(draft, { target: { value: "Kept draft" } });
  view.rerender(tree(true));
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh from management" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh from management" }));
  expect(draft).toHaveValue("Kept draft");
  await act(async () => reply(Response.json(status("signed-in", 2))));
  expect(screen.getByText("Generation 2")).toBeVisible();
  view.rerender(tree(false));
  fireEvent.click(screen.getByRole("button", { name: "Refresh from management" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox", { name: "Management draft" })).toBe(draft);
  expect(draft).toHaveValue("Kept draft");
});

it("shows sanitized account identity when present and preserves legacy signed-in payloads", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ...status("signed-in", 1),
        account: { type: "chatgpt", email: "writer@example.test", plan: "plus" },
      }),
    )
    .mockResolvedValueOnce(Response.json(status("signed-in", 2)));
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId="build" />);
  expect(await screen.findByText("writer@example.test · plus")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(
    await screen.findByText("The workspace’s managed Codex account is connected."),
  ).toBeVisible();
});

it("allows cancellation during a slow background poll and ignores its late response", async () => {
  vi.useFakeTimers();
  let latePoll!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        status("pending", 1, {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "CANCEL-1234",
          expiresAt: Date.now() + 600000,
        }),
      ),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          latePoll = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(status("cancelled", 2)));
  vi.stubGlobal("fetch", fetcher);
  render(<CodexAccountCard workspaceId="workspace" buildId="build" />);
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await act(async () => {});
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
  expect(screen.getByText("Codex sign-in cancelled.")).toBeVisible();
  await act(async () => latePoll(Response.json(status("signed-in", 99))));
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).request.action)).toEqual([
    "status",
    "status",
    "cancel",
  ]);
});

it("returns Escape focus to Disconnect and successful sign-out focus to Connect", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(status("signed-in", 1)))
      .mockResolvedValueOnce(Response.json(status("signed-out", 2))),
  );
  render(<CodexAccountCard workspaceId="workspace" buildId="build" />);
  const trigger = await screen.findByRole("button", { name: "Disconnect" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(await screen.findByRole("dialog", { name: "Disconnect Codex?" }), {
    key: "Escape",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect Codex" }));
  const connect = await screen.findByRole("button", { name: "Connect Codex" });
  await waitFor(() => expect(connect).toHaveFocus());
});
