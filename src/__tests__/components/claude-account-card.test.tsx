// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.unstubAllGlobals();
});
it("shows only the CLI's official link and submits one fenced code without retaining it", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(pending()))
    .mockResolvedValueOnce(Response.json(pending(2, true)));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" />);
  expect(await screen.findByRole("link", { name: "Open official Claude sign-in" })).toHaveAttribute(
    "href",
    "https://claude.com/cai/oauth/authorize?state=fixture",
  );
  const field = screen.getByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "PRIVATE_CODE#STATE" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit code once" }));
  expect(field).toHaveValue("");
  expect(await screen.findByText(/Code submitted/)).toBeVisible();
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
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
  const view = render(<ClaudeAccountCard workspaceId="old" />);
  const field = await screen.findByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "OLD_CODE#STATE" } });
  view.rerender(<ClaudeAccountCard workspaceId="new" />);
  expect(
    screen.queryByRole("link", { name: "Open official Claude sign-in" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("One-time sign-in code")).not.toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toContain("/new/");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: "status" });
});
it("lost code ACK clears the input and requires status instead of replay", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(pending()))
    .mockRejectedValueOnce(Error("lost ack"));
  vi.stubGlobal("fetch", fetcher);
  render(<ClaudeAccountCard workspaceId="workspace" />);
  const field = await screen.findByLabelText("One-time sign-in code");
  fireEvent.change(field, { target: { value: "PRIVATE_CODE#STATE" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit code once" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("outcome is unknown");
  expect(field).toHaveValue("");
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Submit code once" })).toBeDisabled();
});
