// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountMaintenanceCard } from "@/components/workspaces/AccountMaintenanceCard";

const runtimeId = "00000000-0000-4000-8000-000000000001";
const view = (state = "available") => ({
  schemaVersion: 1,
  version: 0,
  maintenanceId: null,
  state,
  holdReason: null,
  runtimeId,
  runtimeGeneration: 1,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("requires explicit confirmation, never requests turn cancellation and holds uncertain actions", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(view()))
    .mockRejectedValueOnce(Error("unknown"));
  vi.stubGlobal("fetch", fetcher);
  render(<AccountMaintenanceCard workspaceId="first" />);
  const pause = await screen.findByRole("button", { name: "Pause for account changes" });
  expect(pause).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(pause);
  expect(await screen.findByRole("alert")).toHaveTextContent("outcome is unknown");
  expect(pause).toBeDisabled();
  const sent = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(sent).toMatchObject({
    action: "request",
    confirmed: true,
    runtimeId,
    runtimeGeneration: 1,
    expectedVersion: 0,
  });
  expect(Object.keys(sent).sort()).toEqual([
    "action",
    "confirmed",
    "expectedVersion",
    "requestId",
    "runtimeGeneration",
    "runtimeId",
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("workspace switch hides old maintenance and discards a late old response", async () => {
  let reply: (v: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(view()))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          reply = r;
        }),
    )
    .mockResolvedValueOnce(
      Response.json({ ...view("ready"), version: 8, maintenanceId: runtimeId }),
    );
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<AccountMaintenanceCard workspaceId="first" />);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh maintenance status" }));
  rerender(<AccountMaintenanceCard workspaceId="second" />);
  expect(
    screen.queryByRole("button", { name: "Pause for account changes" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Resume retained work" })).toBeDisabled();
  reply(Response.json(view()));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(
    screen.queryByRole("button", { name: "Pause for account changes" }),
  ).not.toBeInTheDocument();
});
