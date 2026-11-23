// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://hive.kethalia.com/settings"}

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppPreviewVersions } from "@/components/app-preview-versions";

const entries = [
  {
    slug: "codex-task",
    number: 458,
    title: "Managed task",
    branch: "codex/task",
    revision: "a".repeat(40),
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { responseStatus: 503, retain: true },
  { responseStatus: 401, retain: false },
  { responseStatus: 403, retain: false },
])("handles a preview refresh failure with status $responseStatus", async ({
  responseStatus,
  retain,
}) => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(entries))
    .mockResolvedValueOnce(Response.json(entries[0]))
    .mockResolvedValueOnce(new Response(null, { status: responseStatus }));
  vi.stubGlobal("fetch", fetch);
  render(<AppPreviewVersions />);

  const details = screen.getByText("Preview versions").closest("details");
  if (!details) throw new Error("Preview disclosure missing");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  const label = /#458 Managed task/;
  expect(await screen.findByRole("link", { name: label })).toHaveAttribute(
    "href",
    "/app-preview/codex-task",
  );

  fireEvent.click(screen.getByRole("button", { name: "Refresh previews" }));
  expect(screen.getByRole("button", { name: "Refreshing previews…" })).toBeDisabled();
  expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load preview versions");
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  if (retain) expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  else expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
});

it("shows a healthy preview when a different branch cannot be reached", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/app-previews?view=candidates")
        return Response.json([...entries, { ...entries[0], slug: "broken", number: 459 }]);
      if (url.startsWith("https://broken.")) throw new TypeError("Preview unreachable");
      return Response.json(entries[0]);
    }),
  );
  render(<AppPreviewVersions />);

  const details = screen.getByText("Preview versions").closest("details");
  if (!details) throw new Error("Preview disclosure missing");
  details.open = true;
  fireEvent(details, new Event("toggle"));

  expect(await screen.findByRole("link", { name: /#458 Managed task/ })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /#459/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
