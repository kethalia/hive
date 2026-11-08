// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  render(<CodexAccountCard workspaceId="workspace" />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Codex" }));
  expect(await screen.findByRole("link", { name: "Open official Codex sign-in" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  expect(screen.getByText("ABCD-1234")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
    action: "cancel",
    lifetimeId,
    generation: 1,
  });
});
it("busy state offers status retry without interrupting a native session", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(status("busy"))));
  render(<CodexAccountCard workspaceId="workspace" />);
  expect(await screen.findByText(/A managed runtime is running/)).toBeVisible();
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
  const view = render(<CodexAccountCard workspaceId="old-workspace" />);
  expect(await screen.findByText("OLD-CODE")).toBeVisible();
  view.rerender(<CodexAccountCard workspaceId="new-workspace" />);
  expect(screen.queryByText("OLD-CODE")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toContain("new-workspace");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: "status" });
  reply(Response.json(status()));
  expect(await screen.findByRole("button", { name: "Connect Codex" })).toBeVisible();
});
