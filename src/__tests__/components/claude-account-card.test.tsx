// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeAccountCard } from "@/components/workspaces/ClaudeAccountCard";

const lifetimeId = "00000000-0000-4000-8000-000000000001";
const pending = (generation = 1, codeSubmitted = false) => ({
  scope: "workspace-cli",
  lifetimeId,
  generation,
  state: "pending",
  pending: {
    verificationUrl: "https://claude.com/cai/oauth/authorize?state=fixture",
    codeSubmitted,
    expiresAt: Date.now() + 600000,
  },
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("shows only the CLI's official link and submits one fenced code without retaining it", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(pending()))
    .mockResolvedValueOnce(Response.json(pending(2, true)));
  vi.stubGlobal("fetch", fetcher);
  render(
    <ClaudeAccountCard workspaceId="workspace" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  expect(await screen.findByRole("link", { name: "Open official Claude sign-in" })).toHaveAttribute(
    "href",
    "https://claude.com/cai/oauth/authorize?state=fixture",
  );
  const field = screen.getByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "PRIVATE_CODE#STATE" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit code once" }));
  expect(field).toHaveValue("");
  expect(await screen.findByText(/Code submitted/)).toBeVisible();
  expect(JSON.parse(fetcher.mock.calls[1][1].body).request).toEqual({
    action: "code",
    lifetimeId,
    generation: 1,
    code: "PRIVATE_CODE#STATE",
  });
  expect(screen.queryByLabelText("One-time sign-in code")).not.toBeInTheDocument();
});
it("workspace changes immediately hide old URL/code/fence while a new read is pending", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(pending(7)))
    .mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const view = render(
    <ClaudeAccountCard workspaceId="old" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  const field = await screen.findByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "OLD_CODE#STATE" } });
  view.rerender(
    <ClaudeAccountCard workspaceId="new" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  expect(
    screen.queryByRole("link", { name: "Open official Claude sign-in" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("One-time sign-in code")).not.toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toContain("/new/");
  expect(JSON.parse(fetcher.mock.calls[1][1].body).request).toEqual({ action: "status" });
});
it("lost code ACK clears the input and requires status instead of replay", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(pending()))
    .mockRejectedValueOnce(Error("lost ack"));
  vi.stubGlobal("fetch", fetcher);
  render(
    <ClaudeAccountCard workspaceId="workspace" buildId="22222222-2222-4222-8222-222222222222" />,
  );
  const field = await screen.findByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "PRIVATE_CODE#STATE" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit code once" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("outcome is unknown");
  expect(field).toHaveValue("");
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Submit code once" })).toBeDisabled();
});

it("isolates the one-time code and account fence when the selected build changes", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(pending(7)))
    .mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<ClaudeAccountCard workspaceId="workspace" buildId="old-build" />);
  const field = await screen.findByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "OLD_CODE#STATE" } });
  view.rerender(<ClaudeAccountCard workspaceId="workspace" buildId="new-build" />);
  expect(screen.queryByLabelText("One-time sign-in code")).not.toBeInTheDocument();
  expect(screen.getByText("Checking Claude connection…")).toBeVisible();
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
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
    .mockResolvedValueOnce(Response.json(pending()));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="selected-build" />);
  expect(screen.getByText("Checking Claude connection…")).toBeVisible();
  await act(async () => respond(new Response(null, { status: 404 })));
  expect(await screen.findByText(/Claude connection is unavailable/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect Claude" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await screen.findByRole("button", { name: "Cancel sign-in" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("distinguishes an unavailable status read from an uncertain account mutation", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(Error("bridge unavailable"))
    .mockResolvedValueOnce(Response.json(pending()))
    .mockRejectedValueOnce(Error("mutation acknowledgement lost"));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="selected-build" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Account status unavailable. Check workspace bridge setup and refresh.",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
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

it("keeps a code attempt locked after unknown ACK and a readback that still awaits a code", async () => {
  const attempt = pending();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(attempt))
    .mockRejectedValueOnce(Error("unknown acknowledgement"))
    .mockResolvedValueOnce(Response.json({ ...attempt, generation: 2 }));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="build" />);
  const field = await screen.findByLabelText("One-time sign-in code");
  expect(field).toHaveAttribute("type", "password");
  fireEvent.change(field, { target: { value: "SECRET_CODE#STATE" } });
  fireEvent.submit(screen.getByRole("button", { name: "Submit code once" }).closest("form")!);
  await screen.findByRole("alert");
  expect(field).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Submit code once" })).toBeDisabled();
  expect(screen.getByLabelText("One-time sign-in code")).toBeDisabled();
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).request.action)).toEqual([
    "status",
    "code",
    "status",
  ]);
  expect(screen.queryByText("SECRET_CODE#STATE")).not.toBeInTheDocument();
});

it("clears typed code when a refreshed response replaces the challenge", async () => {
  const first = pending(1);
  const second = {
    ...pending(2),
    pending: {
      ...pending(2).pending,
      verificationUrl: "https://claude.com/cai/oauth/authorize?state=replacement",
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(first))
    .mockResolvedValueOnce(Response.json(second));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="build" />);
  fireEvent.change(await screen.findByLabelText("One-time sign-in code"), {
    target: { value: "OLD_SECRET#STATE" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "Open official Claude sign-in" })).toHaveAttribute(
      "href",
      second.pending.verificationUrl,
    ),
  );
  expect(screen.getByLabelText("One-time sign-in code")).toHaveValue("");
});

it("hides expired Claude credentials until status readback permits a fresh sign-in", async () => {
  const expiredAttempt = {
    ...pending(),
    pending: { ...pending().pending, expiresAt: Date.now() - 1000 },
  };
  let reply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(expiredAttempt))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="build" />);
  await screen.findByText("Code expired");
  expect(screen.queryByLabelText("One-time sign-in code")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open official Claude sign-in" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeDisabled();
  await act(async () => reply(Response.json({ ...pending(2), state: "expired", pending: null })));
  expect(await screen.findByRole("button", { name: "Connect Claude" })).toBeEnabled();
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).request.action)).toEqual([
    "status",
    "status",
  ]);
});

it("reports a completed Claude sign-in when cancellation loses the race", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(pending()))
    .mockResolvedValueOnce(Response.json({ ...pending(2), state: "signed-in", pending: null }));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="build" />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
  expect(await screen.findByText("Claude sign-in completed before cancellation.")).toBeVisible();
  expect(screen.getByText("Connected")).toBeVisible();
});

it("requires disconnect confirmation and preserves unknown outcomes for status readback", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ...pending(7), state: "signed-in", pending: null }))
    .mockRejectedValueOnce(Error("lost ACK"));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="build" />);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  await screen.findByRole("dialog", { name: "Disconnect Claude?" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("outcome is unknown");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(JSON.parse(fetcher.mock.calls[1][1].body).request).toEqual({
    action: "disconnect",
    lifetimeId,
    generation: 7,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
});

it("checks wall-clock expiry before sending a code after timer throttling", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const attempt = { ...pending(), pending: { ...pending().pending, expiresAt: now + 5000 } };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(attempt))
    .mockResolvedValueOnce(Response.json({ ...pending(2), state: "expired", pending: null }));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" buildId="build" />);
  await act(async () => {});
  const field = screen.getByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "EXPIRED_SECRET#STATE" } });
  vi.setSystemTime(now + 6000);
  await act(async () =>
    fireEvent.submit(screen.getByRole("button", { name: "Submit code once" }).closest("form")!),
  );
  expect(fetcher.mock.calls.map(([, request]) => JSON.parse(request.body).request.action)).toEqual([
    "status",
    "status",
  ]);
  expect(screen.queryByLabelText("One-time sign-in code")).not.toBeInTheDocument();
});

it("returns dialog dismissal to Disconnect and successful sign-out to Connect", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...pending(1), state: "signed-in", pending: null }))
      .mockResolvedValueOnce(Response.json({ ...pending(2), state: "signed-out", pending: null })),
  );
  render(<ClaudeAccountCard workspaceId="workspace" buildId="build" />);
  const trigger = await screen.findByRole("button", { name: "Disconnect" });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "Disconnect Claude?" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect Claude" }));
  const connect = await screen.findByRole("button", { name: "Connect Claude" });
  await waitFor(() => expect(connect).toHaveFocus());
});
