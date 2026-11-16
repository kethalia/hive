// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexUsageSettings } from "@/components/workspaces/CodexUsageSettings";

const lifetimeId = "00000000-0000-4000-8000-000000000001";
const values = {
  model: "sol",
  review_model: null,
  model_reasoning_effort: "high",
  model_verbosity: null,
  web_search: "cached",
  service_tier: null,
};
const config = (version = "v1") => ({
  version,
  values,
  origins: { model: "user" },
  truncated: false,
  models: [{ id: "sol", name: "Sol", efforts: ["low", "high"], tiers: [] }],
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
});
const usage = {
  limitsAvailable: true,
  usageAvailable: true,
  windows: [
    {
      id: "codex",
      name: "Codex",
      primary: { usedPercent: 20, minutes: 300, resetsAt: 1_900_000_000 },
      secondary: null,
    },
  ],
  credits: { balance: "12", unlimited: false },
  resetCredits: null,
  resets: null,
  tokens: { lifetime: 1200, peakDaily: 600, daily: [{ date: "2026-11-16", tokens: 600 }] },
};
function response(section: "usage" | "config", generation = 4, version = "v1") {
  return Response.json({
    scope: "managed-native",
    lifetimeId,
    generation,
    outcome: "read",
    usage: section === "usage" ? usage : null,
    config: section === "config" ? config(version) : null,
    overridden: null,
  });
}
function mount() {
  const onBusyChange = vi.fn();
  const onAccountRefresh = vi.fn();
  const props = {
    workspaceId: "workspace",
    buildId: "build",
    lifetimeId,
    disabled: false,
    onBusyChange,
    onAccountRefresh,
  };
  const view = render(<CodexUsageSettings {...props} generation={4} />);
  return {
    ...view,
    onBusyChange,
    onAccountRefresh,
    updateGeneration: (generation: number) =>
      view.rerender(<CodexUsageSettings {...props} generation={generation} />),
  };
}
async function chooseDetail() {
  fireEvent.click(screen.getByRole("combobox", { name: "Response detail" }));
  const option = await screen.findByRole("option", { name: "medium" });
  fireEvent.mouseMove(option);
  fireEvent.click(option);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows native usage, loads settings on selection and saves with the current version and fence", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response("usage"))
    .mockResolvedValueOnce(response("config"))
    .mockResolvedValueOnce(
      Response.json({
        scope: "managed-native",
        lifetimeId,
        generation: 5,
        outcome: "saved",
        usage: null,
        config: { ...config("v2"), values: { ...values, model_verbosity: "medium" } },
        overridden: false,
      }),
    )
    .mockResolvedValueOnce(response("config", 5, "v2"));
  vi.stubGlobal("fetch", fetcher);
  const view = mount();
  expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuetext", "80% remaining");
  expect(screen.getByText("1,200")).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("tab", { name: "Runtime settings" }));
  await screen.findByRole("combobox", { name: "Model" });
  expect(screen.getByText("Source user")).toBeVisible();
  await chooseDetail();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByText("Settings saved.")).toBeVisible();
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
    buildId: "build",
    request: {
      action: "save-config",
      lifetimeId,
      generation: 4,
      version: "v1",
      values: { model_verbosity: "medium" },
    },
  });
  expect(fetcher.mock.calls[2][0]).toBe("/api/workspaces/workspace/codex-management");
  expect(view.onAccountRefresh).toHaveBeenCalledTimes(1);
  expect(view.onBusyChange.mock.lastCall).toEqual([false]);
  fireEvent.click(screen.getByRole("button", { name: "Refresh settings" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  expect(JSON.parse(fetcher.mock.calls[3][1].body).request.generation).toBe(5);
});

it("keeps uncertain saves blocked until an explicit settings readback and version review", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response("usage"))
    .mockResolvedValueOnce(response("config"))
    .mockRejectedValueOnce(Error("lost write acknowledgement"))
    .mockResolvedValueOnce(response("config", 5, "v2"));
  vi.stubGlobal("fetch", fetcher);
  const view = mount();
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("tab", { name: "Runtime settings" }));
  await screen.findByRole("combobox", { name: "Model" });
  await chooseDetail();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings outcome is unknown");
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(view.onAccountRefresh).toHaveBeenCalledTimes(1);
  // The real account read supplies the generation advanced by the uncertain write.
  view.updateGeneration(5);
  fireEvent.click(screen.getByRole("button", { name: "Refresh settings" }));
  await screen.findByText(/Configuration changed while you were editing/);
  expect(JSON.parse(fetcher.mock.calls[3][1].body).request.generation).toBe(5);
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep edits on current version" }));
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  expect(
    fetcher.mock.calls.filter(
      ([, request]) => JSON.parse(request.body).request.action === "save-config",
    ),
  ).toHaveLength(1);
});

it("retains usage after a failed refresh and displays bounded recovery feedback", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response("usage"))
    .mockResolvedValueOnce(Response.json({ private: "not-displayable" }, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  mount();
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex details could not be refreshed",
  );
  expect(screen.getByRole("progressbar")).toBeVisible();
  expect(screen.queryByText("not-displayable")).not.toBeInTheDocument();
});

it("aborts an unmounted read and never publishes a late response", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = mount();
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response("usage")));
  expect(view.onBusyChange.mock.lastCall).toEqual([false]);
});

it("explains an unavailable runtime and allows a read-only retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(response("usage"));
  vi.stubGlobal("fetch", fetcher);
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Usage and settings are unavailable for this workspace",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(await screen.findByRole("progressbar")).toBeVisible();
});

it("rejects a response from another bridge lifetime while retaining the last usage snapshot", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response("usage"))
    .mockResolvedValueOnce(
      Response.json({
        scope: "managed-native",
        lifetimeId: "00000000-0000-4000-8000-000000000002",
        generation: 4,
        outcome: "read",
        usage,
        config: null,
        overridden: null,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const view = mount();
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex details could not be refreshed",
  );
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "80% remaining");
  expect(view.onAccountRefresh).toHaveBeenCalledTimes(1);
});
